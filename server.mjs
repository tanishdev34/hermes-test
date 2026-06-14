import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = process.env.PORT || 3200;

// Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || 'https://REDACTED_REDIS',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || 'REDACTED_TOKEN',
});

// ESPN API (free, no auth)
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

// Smart cache TTLs
const TTL = {
  LIVE: 30,           // 30s for live matches
  FINISHED: 6 * 3600, // 6h for completed
  SCHEDULED: 3 * 3600, // 3h for upcoming
  STANDINGS: 6 * 3600,
  MATCH_DETAIL: 3 * 3600,
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

// Convert ESPN event to our format
function mapEvent(e) {
  const comp = e.competitions?.[0] || {};
  const teams = comp.competitors || [];
  const home = teams.find(t => t.homeAway === 'home') || {};
  const away = teams.find(t => t.homeAway === 'away') || {};
  const status = comp.status?.type?.name || '';
  const statusShort = comp.status?.type?.shortDetail || '';

  let mappedStatus = 'upcoming';
  if (status.includes('FULL') || status.includes('FINAL')) mappedStatus = 'finished';
  else if (status.includes('HALF') || status.includes('IN_PROGRESS') || status.includes('LIVE')) mappedStatus = 'live';

  return {
    id: e.id,
    date: e.date,
    name: e.name,
    status: mappedStatus,
    statusDetail: statusShort,
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

// Get match detail with events/lineups from ESPN
async function getMatchDetail(id) {
  const cacheKey = `wc:detail:${id}`;
  const cached = await redisGet(cacheKey);
  if (cached) return cached;

  const data = await espnFetch(`/summary?event=${id}`);
  if (!data) return null;

  const result = {
    events: [],
    lineups: [],
    stats: [],
  };

  // Extract key events (goals, cards, subs)
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

  // Extract lineups from rosters array
  for (const r of data.rosters || []) {
    const teamName = r.team?.displayName || '';
    const teamAbbr = r.team?.abbreviation || '';
    const formation = r.formation || '';
    const xi = [];
    const subs = [];
    for (const p of r.roster || []) {
      const player = {
        number: p.jersey || '',
        name: p.athlete?.displayName || '',
        pos: p.athlete?.position?.abbreviation || '',
      };
      if (p.starter) xi.push(player);
      else subs.push(player);
    }
    result.lineups.push({ team: teamName, teamAbbr, formation, xi, subs });
  }

  // Extract stats from boxscore teams
  for (const t of data.boxscore?.teams || []) {
    const teamName = t.team?.abbreviation || '';
    const stats = {};
    for (const s of t.statistics || []) {
      stats[s.name?.toLowerCase().replace(/\s+/g, '') || ''] = s.displayValue || '0';
    }
    result.stats.push({ team: teamName, stats });
  }

  // Short cache for live, longer for finished
  const status = data.header?.competitions?.[0]?.status?.type?.name || '';
  const ttl = status.includes('FULL') ? TTL.FINISHED :
              status.includes('IN_PROGRESS') || status.includes('HALF') ? TTL.LIVE :
              TTL.SCHEDULED;
  await redisSet(cacheKey, result, ttl);
  return result;
}

const app = new Hono();

// All matches (today + recent)
app.get('/api/matches', async (c) => {
  const cacheKey = 'wc:matches:today';
  let events = await redisGet(cacheKey);

  if (!events) {
    // Fetch today and yesterday and tomorrow
    const today = new Date();
    const dates = [-1, 0, 1].map(offset => {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    });

    const allEvents = [];
    for (const date of dates) {
      const data = await espnFetch(`/scoreboard?dates=${date}`);
      if (data?.events) allEvents.push(...data.events);
    }
    events = allEvents.map(mapEvent);
    await redisSet(cacheKey, events, TTL.LIVE);
  }

  return c.json(events);
});

// Live matches only
app.get('/api/matches/live', async (c) => {
  const data = await espnFetch('/scoreboard');
  const live = (data?.events || [])
    .map(mapEvent)
    .filter(m => m.status === 'live');
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
    const res = await espnFetch('/standings');
    data = res || { error: 'No data' };
    await redisSet(cacheKey, data, TTL.STANDINGS);
  }
  return c.json(data);
});

// Status
app.get('/api/status', async (c) => {
  let redisOk = false;
  try { await redis.ping(); redisOk = true; } catch {}
  return c.json({ ok: true, redis: redisOk, source: 'ESPN', port: PORT });
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
  console.log(`📡 Data: ESPN public API (free, no key)`);
  console.log(`🗄️  Cache: Upstash Redis`);
  console.log(`💡 TTLs: Live=30s, Finished=6h, Standings=6h`);
});
