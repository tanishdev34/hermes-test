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
  connectionString: process.env.DATABASE_URL,,
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
      score: home.score ?? null,
      logo: home.team?.logo || '',
    },
    away: {
      id: away.id,
      name: away.team?.displayName || '',
      shortName: away.team?.abbreviation || '',
      score: away.score ?? null,
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
