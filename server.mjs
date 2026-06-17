import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = process.env.PORT || 3200;

// Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// PostgreSQL
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: { rejectUnauthorized: false },
});

// Init DB table
async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS match_details (
        match_id TEXT PRIMARY KEY,
        events JSONB DEFAULT '[]',
        lineups JSONB DEFAULT '[]',
        stats JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('🗄️  PostgreSQL: connected, table ready');
  } catch (e) {
    console.error('PostgreSQL init error:', e.message);
  }
}
initDB();

// ESPN API
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

// Cache TTLs
const TTL = {
  LIVE: 30,
  FINISHED: 6 * 3600,
  SCHEDULED: 3 * 3600,
  STANDINGS: 6 * 3600,
};

async function redisGet(key) {
  try { return await redis.get(key); } catch { return null; }
}
async function redisSet(key, val, ttl) {
  try { await redis.set(key, val, { ex: ttl }); } catch {}
}

async function espnFetch(path) {
  try {
    const res = await fetch(`${ESPN_BASE}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('ESPN error:', e.message);
    return null;
  }
}

function normalizeScore(score) {
  if (score === null || score === undefined || score === '') return null;
  const parsed = Number(score);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapEvent(e) {
  const comp = e.competitions?.[0] || {};
  const teams = comp.competitors || [];
  const home = teams.find(t => t.homeAway === 'home') || {};
  const away = teams.find(t => t.homeAway === 'away') || {};
  const status = comp.status?.type?.name || '';
  const statusDetail = comp.status?.type?.shortDetail || comp.status?.type?.detail || '';

  let mappedStatus = 'upcoming';
  if (status.includes('FULL') || status.includes('FINAL')) mappedStatus = 'finished';
  else if (status.includes('HALF') || status.includes('IN_PROGRESS') || status.includes('LIVE') || status.includes('2ND') || status.includes('1ST')) mappedStatus = 'live';

  return {
    id: e.id,
    date: e.date,
    name: e.name,
    status: mappedStatus,
    statusDetail,
    venue: comp.venue?.fullName || '',
    home: {
      id: home.id,
      name: home.team?.displayName || '',
      shortName: home.team?.abbreviation || '',
      score: normalizeScore(home.score),
      logo: home.team?.logo || '',
    },
    away: {
      id: away.id,
      name: away.team?.displayName || '',
      shortName: away.team?.abbreviation || '',
      score: normalizeScore(away.score),
      logo: away.team?.logo || '',
    },
    group: e.season?.slug || '',
  };
}

// Parse ESPN summary into our format
function parseSummary(data) {
  const result = { events: [], lineups: [], stats: [] };

  for (const e of data.keyEvents || []) {
    const type = e.type?.text || '';
    const typeLower = type.toLowerCase();
    if (['goal', 'yellow card', 'red card', 'substitution', 'penalty - scored', 'penalty - missed'].some(t => typeLower.includes(t))) {
      const player = e.participants?.[0]?.athlete?.displayName || e.shortText || '';
      const assist = e.participants?.[1]?.athlete?.displayName || null;
      result.events.push({
        time: e.clock?.displayValue || '',
        type: typeLower.includes('goal') || typeLower.includes('penalty - scored') ? 'goal'
          : typeLower.includes('card') ? 'card'
          : typeLower.includes('substitution') ? 'subst' : 'other',
        team: e.team?.displayName || '',
        teamId: e.team?.id || '',
        player,
        detail: e.text || type,
        assist,
      });
    }
  }

  for (const r of data.rosters || []) {
    const teamName = r.team?.displayName || '';
    const teamAbbr = r.team?.abbreviation || '';
    const formation = r.formation || '';
    const xi = [];
    const subs = [];
    for (const p of r.roster || []) {
      const player = { number: p.jersey || '', name: p.athlete?.displayName || '', pos: p.athlete?.position?.abbreviation || '' };
      if (p.starter) xi.push(player);
      else subs.push(player);
    }
    result.lineups.push({ team: teamName, teamAbbr, formation, xi, subs });
  }

  for (const t of data.boxscore?.teams || []) {
    const teamName = t.team?.abbreviation || '';
    const stats = {};
    for (const s of t.statistics || []) {
      stats[s.name?.toLowerCase().replace(/\s+/g, '') || ''] = s.displayValue || '0';
    }
    result.stats.push({ team: teamName, stats });
  }

  return result;
}

// Get match detail: DB → ESPN → store in DB
async function getMatchDetail(id) {
  const idStr = String(id);

  // 1. Check PostgreSQL
  try {
    const dbRes = await db.query('SELECT events, lineups, stats FROM match_details WHERE match_id = $1', [idStr]);
    if (dbRes.rows.length > 0) {
      const row = dbRes.rows[0];
      // Only use DB data if it has actual content
      if ((row.events && row.events.length > 0) || (row.lineups && row.lineups.length > 0)) {
        return { events: row.events || [], lineups: row.lineups || [], stats: row.stats || [] };
      }
    }
  } catch (e) {
    console.error('DB read error:', e.message);
  }

  // 2. Fetch from ESPN
  const data = await espnFetch(`/summary?event=${id}`);
  if (!data) return null;

  const parsed = parseSummary(data);

  // 3. Store in PostgreSQL
  try {
    await db.query(
      `INSERT INTO match_details (match_id, events, lineups, stats, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (match_id) DO UPDATE SET
         events = EXCLUDED.events,
         lineups = EXCLUDED.lineups,
         stats = EXCLUDED.stats,
         updated_at = NOW()`,
      [idStr, JSON.stringify(parsed.events), JSON.stringify(parsed.lineups), JSON.stringify(parsed.stats)]
    );
  } catch (e) {
    console.error('DB write error:', e.message);
  }

  return parsed;
}

const app = new Hono();

// All matches — live first, then by date
app.get('/api/matches', async (c) => {
  const cacheKey = 'wc:matches:sorted';
  let events = await redisGet(cacheKey);

  if (!events) {
    const today = new Date();
    // Cover the full tournament (June 11 - July 19, 2026)
    const tournamentStart = new Date('2026-06-11');
    const daysSinceStart = Math.floor((today - tournamentStart) / (1000 * 60 * 60 * 24));
    const startOffset = Math.max(-daysSinceStart, -30);
    const dates = [];
    for (let offset = startOffset; offset <= 2; offset++) {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }

    const allEvents = [];
    for (const date of dates) {
      const data = await espnFetch(`/scoreboard?dates=${date}`);
      if (data?.events) allEvents.push(...data.events);
    }

    // Deduplicate by id
    const seen = new Set();
    const unique = allEvents.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });

    events = unique.map(mapEvent).sort((a, b) => {
      // Live matches first
      const statusOrder = { live: 0, finished: 1, upcoming: 2 };
      const sa = statusOrder[a.status] ?? 2;
      const sb = statusOrder[b.status] ?? 2;
      if (sa !== sb) return sa - sb;
      // Within same status, sort by date (newest first for finished, soonest first for upcoming)
      return new Date(b.date) - new Date(a.date);
    });

    await redisSet(cacheKey, events, TTL.LIVE);
  }

  return c.json(events);
});

// Live matches
app.get('/api/matches/live', async (c) => {
  const data = await espnFetch('/scoreboard');
  const live = (data?.events || []).map(mapEvent).filter(m => m.status === 'live');
  return c.json(live);
});

// Match detail
app.get('/api/match/:id', async (c) => {
  const id = c.req.param('id');
  const detail = await getMatchDetail(id);
  if (detail) return c.json(detail);
  return c.json({ error: 'Match not found' }, 404);
});

// Standings
app.get('/api/standings', async (c) => {
  const cacheKey = 'wc:standings';
  let data = await redisGet(cacheKey);
  if (!data) {
    data = await espnFetch('/standings');
    await redisSet(cacheKey, data, TTL.STANDINGS);
  }
  return c.json(data);
});

// === F1 ENDPOINTS ===
const F1_BACKEND = process.env.F1_BACKEND || 'http://127.0.0.1:4000';
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const F1_TEAM_COLORS = {
  'Red Bull':'#3671C6','Mercedes':'#27F4D2','Ferrari':'#E8002D','McLaren':'#FF8000',
  'Aston Martin':'#229971','Alpine':'#FF87BC','Williams':'#64C4FF','RB':'#6692FF',
  'Sauber':'#52E252','Haas':'#B6BABD','Cadillac':'#1e1e1e',
};

// FastF1 backend proxy helper
async function fastf1Fetch(path, method = 'GET', body = null, signal = null) {
  try {
    const opts = { method, signal: signal || AbortSignal.timeout(8000) };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${F1_BACKEND}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'FastF1 backend error' }));
      return { ok: false, status: res.status, data: err };
    }
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `FastF1 backend unavailable: ${e.message}` } };
  }
}

// Check FastF1 manifest status for a race
async function getFastf1Status(year, round) {
  const res = await fastf1Fetch(`/race/${year}/${round}/manifest`);
  if (res.ok) {
    return res.data.status || 'missing';
  }
  return 'offline';
}

// Season overview — full calendar + standings + optional FastF1 status
app.get('/api/f1/season/:year', async (c) => {
  const year = c.req.param('year');
  const cacheKey = `f1:season:${year}:v3`;
  let cached = await redisGet(cacheKey);
  if (cached) return c.json(cached);

  try {
    const [scheduleRes, standingsRes] = await Promise.all([
      fetch(`${JOLPICA}/${year}.json`),
      fetch(`${JOLPICA}/${year}/driverStandings.json`),
    ]);
    const scheduleData = await scheduleRes.json();
    const standingsData = await standingsRes.json();

    const scheduleRaces = scheduleData?.MRData?.RaceTable?.Races || [];

    const COUNTRY_FLAGS = {'Australia':'🇦🇺','China':'🇨🇳','Japan':'🇯🇵','United States':'🇺🇸','Canada':'🇨🇦','Italy':'🇮🇹','Monaco':'🇲🇨','Spain':'🇪🇸','Austria':'🇦🇹','United Kingdom':'🇬🇧','Hungary':'🇭🇺','Belgium':'🇧🇪','Netherlands':'🇳🇱','Singapore':'🇸🇬','Qatar':'🇶🇦','Mexico':'🇲🇽','Brazil':'🇧🇷','Saudi Arabia':'🇸🇦','Bahrain':'🇧🇭','Azerbaijan':'🇦🇿','Emilia Romagna':'🇮🇹','Miami':'🇺🇸','Las Vegas':'🇺🇸','Abu Dhabi':'🇦🇪'};

    const winnerRequests = scheduleRaces.map(race => {
      const round = parseInt(race.round, 10);
      return fetch(`${JOLPICA}/${year}/${round}/results.json?limit=1`)
        .then(r => r.json())
        .then(data => {
          const raceResult = data?.MRData?.RaceTable?.Races?.[0];
          const winner = raceResult?.Results?.[0];
          return [
            round,
            winner
              ? {
                  name: `${winner.Driver.givenName} ${winner.Driver.familyName}`,
                  team: winner.Constructor?.name || null,
                  color: F1_TEAM_COLORS[winner.Constructor?.name] || '#fff',
                }
              : null,
          ];
        })
        .catch(() => [round, null]);
    });

    const winnerEntries = await Promise.all(winnerRequests);
    const winnerMap = Object.fromEntries(winnerEntries);

    const statusRequests = scheduleRaces.map(race => {
      const round = parseInt(race.round, 10);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      return fastf1Fetch(`/race/${year}/${round}/manifest`, 'GET', null, controller.signal)
        .then(res => [round, res.ok ? (res.data.status || 'missing') : 'missing'])
        .catch(() => [round, 'missing'])
        .finally(() => clearTimeout(timeout));
    });

    const statusEntries = await Promise.all(statusRequests);
    const statusMap = Object.fromEntries(statusEntries);

    const races = scheduleRaces.map(race => {
      const round = parseInt(race.round, 10);
      const winner = winnerMap[round];
      return {
        round,
        name: race.raceName,
        circuit: race.Circuit?.circuitName || '',
        country: race.Circuit?.Location?.country || '',
        date: race.date,
        flag: COUNTRY_FLAGS[race.Circuit?.Location?.country] || '🏁',
        winner: winner?.name || null,
        winner_team: winner?.team || null,
        winner_color: winner?.color || '#fff',
        fastf1_status: statusMap[round] || 'missing',
        year: parseInt(year),
      };
    });

    const driverStandings = (standingsData?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || []).map(d => ({
      driver: `${d.Driver.givenName} ${d.Driver.familyName}`,
      team: d.Constructors?.[0]?.name || '',
      points: parseInt(d.points),
      color: F1_TEAM_COLORS[d.Constructors?.[0]?.name] || '#fff',
    }));

    const result = { races, driver_standings: driverStandings };
    await redisSet(cacheKey, result, 3 * 3600);
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Failed to load F1 data' }, 500);
  }
});

// Race detail — tries FastF1 first, falls back to Jolpica
app.get('/api/f1/race/:year/:round', async (c) => {
  const year = c.req.param('year');
  const round = c.req.param('round');
  const cacheKey = `f1:race:${year}:${round}:v2`;
  let cached = await redisGet(cacheKey);
  if (cached && (cached.fastf1_status === 'ready' || cached.fastf1_status === 'summary_ready')) return c.json(cached);
  if (cached) await redis.del(cacheKey);
  cached = null;

  // Try FastF1 backend first
  const ff1 = await fastf1Fetch(`/race/${year}/${round}`);
  if (ff1.ok && ff1.data.results?.length > 0) {
    await redisSet(cacheKey, ff1.data, 15 * 60); // cache 15min
    return c.json(ff1.data);
  }

  // Fallback to Jolpica
  try {
    const [resultsRes, lapsRes, pitstopsRes] = await Promise.all([
      fetch(`${JOLPICA}/${year}/${round}/results.json`),
      fetch(`${JOLPICA}/${year}/${round}/laps.json?limit=3000`),
      fetch(`${JOLPICA}/${year}/${round}/pitstops.json`),
    ]);
    const resultsData = await resultsRes.json();
    const lapsData = await lapsRes.json();
    const pitstopsData = await pitstopsRes.json();

    const race = resultsData?.MRData?.RaceTable?.Races?.[0];
    if (!race) return c.json({ error: 'Race not found' }, 404);

    const results = (race.Results || []).map(r => ({
      position: parseInt(r.position),
      driver: `${r.Driver.givenName} ${r.Driver.familyName}`,
      full_name: `${r.Driver.givenName} ${r.Driver.familyName}`,
      abbreviation: r.Driver.code || r.Driver.driverId?.substring(0,3).toUpperCase(),
      number: r.number,
      driver_number: r.number,
      team: r.Constructor?.name || '',
      team_name: r.Constructor?.name || '',
      color: F1_TEAM_COLORS[r.Constructor?.name] || '#fff',
      team_color: F1_TEAM_COLORS[r.Constructor?.name] || '#fff',
      grid: parseInt(r.grid) || 0,
      grid_position: parseInt(r.grid) || 0,
      time: r.Time?.time || '',
      gap: r.gap || '',
      points: parseInt(r.points) || 0,
      best_lap: r.FastestLap?.Time?.time || '',
      status: r.status || '',
    }));

    // Parse laps
    const laps = [];
    const lapData = lapsData?.MRData?.RaceTable?.Races?.[0]?.Laps || [];
    for (const lap of lapData) {
      for (const timing of (lap.Timings || [])) {
        const abbr = timing.driverId?.substring(0,3).toUpperCase() || timing.driverId;
        laps.push({
          driver: abbr,
          lap: parseInt(lap.number),
          position: parseInt(timing.position),
        });
      }
    }

    // Strategy from pitstops
    const pitstops = pitstopsData?.MRData?.RaceTable?.Races?.[0]?.PitStops || [];
    const strategyMap = {};
    for (const ps of pitstops) {
      if (!strategyMap[ps.driverId]) strategyMap[ps.driverId] = [];
      strategyMap[ps.driverId].push({ lap: parseInt(ps.lap), stop: parseInt(ps.stop), duration: ps.duration });
    }

    const strategy = Object.entries(strategyMap).map(([driverId, stops]) => {
      const driverInfo = results.find(r => {
        const id = r.driver.toLowerCase().replace(/\s+/g, '');
        return id.includes(driverId) || driverId.includes(id.substring(0,5));
      }) || {};
      const stints = [];
      let lastLap = 1;
      for (const stop of stops) {
        const compound = stop.lap < 20 ? 'SOFT' : stop.lap < 35 ? 'MEDIUM' : 'HARD';
        stints.push({ start_lap: lastLap, end_lap: stop.lap, laps: stop.lap - lastLap + 1, compound, tyre_age: 0 });
        lastLap = stop.lap + 1;
      }
      const totalLaps = Math.max(...laps.map(l => l.lap), 50);
      const compound = lastLap < totalLaps * 0.4 ? 'MEDIUM' : 'HARD';
      stints.push({ start_lap: lastLap, end_lap: totalLaps, laps: totalLaps - lastLap + 1, compound, tyre_age: 0 });
      return {
        driver: driverInfo.driver || driverId,
        abbreviation: driverInfo.abbreviation || driverId,
        team: driverInfo.team || '',
        color: driverInfo.color || '#fff',
        stints,
      };
    });

    // Fastest lap
    const fastestResult = results.find(r => r.best_lap);
    const fastest_lap = fastestResult ? {
      driver: fastestResult.driver,
      team: fastestResult.team,
      time: fastestResult.best_lap,
      lap: '',
      speed_fl: 0,
      sector1: '', sector2: '', sector3: '',
      compound: '',
    } : null;

    // Try to get FastF1 status
    const fastf1_status = await getFastf1Status(year, round);

    const result = {
      name: race.raceName,
      year: parseInt(year),
      round: parseInt(round),
      circuit: race.Circuit?.circuitName || '',
      date: race.date,
      total_laps: Math.max(...laps.map(l => l.lap), 0),
      results,
      laps,
      strategy,
      fastest_lap,
      weather: [],
      race_control: [],
      telemetry: {},
      fastf1_status,
      fastf1_ready: fastf1_status === 'ready',
      fastf1_source: fastf1_status === 'ready' ? 'fastf1' : 'jolpica',
      detail_endpoints: {
        manifest: `/api/f1/race/${year}/${round}/manifest`,
        laps: `/api/f1/race/${year}/${round}/laps`,
        strategy: `/api/f1/race/${year}/${round}/strategy`,
        weather: `/api/f1/race/${year}/${round}/weather`,
        raceControl: `/api/f1/race/${year}/${round}/race-control`,
        trackMap: `/api/f1/race/${year}/${round}/track-map`,
        telemetryIndex: `/api/f1/race/${year}/${round}/telemetry-index`,
      }
    };

    await redisSet(cacheKey, result, 6 * 3600);
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'Failed to load race data' }, 500);
  }
});

// FastF1 proxy endpoints
app.get('/api/f1/race/:year/:round/manifest', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/manifest`);
  return c.json(res.data);
});

app.post('/api/f1/race/:year/:round/prepare', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/prepare`, 'POST');
  return c.json(res.data, res.ok ? 200 : res.status || 500);
});

app.get('/api/f1/race/:year/:round/laps', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/laps`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/strategy', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/strategy`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/weather', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/weather`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/race-control', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/race-control`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/track-map', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/track-map`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/telemetry-index', async (c) => {
  const { year, round } = c.req.param();
  const res = await fastf1Fetch(`/race/${year}/${round}/telemetry-index`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

app.get('/api/f1/race/:year/:round/telemetry', async (c) => {
  const { year, round } = c.req.param();
  const driver = c.req.query('driver');
  const lap = c.req.query('lap');
  if (!driver || !lap) return c.json({ error: 'Missing driver or lap param' }, 400);
  const res = await fastf1Fetch(`/race/${year}/${round}/telemetry?driver=${driver}&lap=${lap}`);
  if (res.ok) return c.json(res.data);
  return c.json(res.data, res.status || 500);
});

// Status
app.get('/api/status', async (c) => {
  let redisOk = false, pgOk = false;
  try { await redis.ping(); redisOk = true; } catch {}
  try { await db.query('SELECT 1'); pgOk = true; } catch {}
  return c.json({ ok: true, redis: redisOk, postgres: pgOk, source: 'ESPN', port: PORT });
});

// Static files
app.use('/*', serveStatic({ root: './dist' }));

// SPA fallback
app.get('*', async (c) => {
  const html = await readFile(join(DIST, 'index.html'), 'utf-8');
  return c.html(html);
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`⚽ WC 2026 — The Pulse`);
  console.log(`🚀 http://0.0.0.0:${info.port}`);
  console.log(`📡 Data: ESPN public API`);
  console.log(`🗄️  Cache: Redis + PostgreSQL`);
  console.log(`💡 Live matches pinned to top`);
});
