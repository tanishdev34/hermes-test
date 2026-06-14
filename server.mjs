import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = process.env.PORT || 3200;

// API-Football config — get free key at https://rapidapi.com/api-sports/api/api-football
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const API_BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

// Cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  return null;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

async function apiFetch(endpoint) {
  if (!API_KEY) return null;
  const cached = getCached(endpoint);
  if (cached) return cached;
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    setCache(endpoint, data);
    return data;
  } catch (e) {
    console.error('API error:', e.message);
    return null;
  }
}

const app = new Hono();

// All matches
app.get('/api/matches', async (c) => {
  const data = await apiFetch(`/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key. Set API_FOOTBALL_KEY env var.' }, 401);
});

// Live matches
app.get('/api/matches/live', async (c) => {
  const data = await apiFetch(`/fixtures?live=all&league=${WC_LEAGUE}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key or no live matches.' }, 401);
});

// Match detail — events, lineups, stats
app.get('/api/match/:id', async (c) => {
  const id = c.req.param('id');
  const [fixture, events, lineups, stats] = await Promise.all([
    apiFetch(`/fixtures?id=${id}`),
    apiFetch(`/fixtures/events?fixture=${id}`),
    apiFetch(`/fixtures/lineups?fixture=${id}`),
    apiFetch(`/fixtures/statistics?fixture=${id}`),
  ]);
  if (fixture?.response?.[0]) {
    return c.json({
      fixture: fixture.response[0],
      events: events?.response || [],
      lineups: lineups?.response || [],
      stats: stats?.response || [],
    });
  }
  return c.json({ error: 'Match not found or no API key.' }, 404);
});

// Standings
app.get('/api/standings', async (c) => {
  const data = await apiFetch(`/standings?league=${WC_LEAGUE}&season=${WC_SEASON}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key.' }, 401);
});

// Top scorers
app.get('/api/topscorers', async (c) => {
  const data = await apiFetch(`/players/topscorers?league=${WC_LEAGUE}&season=${WC_SEASON}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key.' }, 401);
});

// Top goalkeepers (saves)
app.get('/api/topkeepers', async (c) => {
  const data = await apiFetch(`/players/topsaves?league=${WC_LEAGUE}&season=${WC_SEASON}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key.' }, 401);
});

// Predictions
app.get('/api/predictions/:fixtureId', async (c) => {
  const id = c.req.param('fixtureId');
  const data = await apiFetch(`/predictions?fixture=${id}`);
  if (data?.response) return c.json(data.response);
  return c.json({ error: 'No API key.' }, 401);
});

// Health check
app.get('/api/status', (c) => c.json({
  ok: true,
  apiKey: !!API_KEY,
  port: PORT,
}));

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
  console.log(`📡 API-Football: ${API_KEY ? '✅ Connected' : '❌ No key — set API_FOOTBALL_KEY env var'}`);
  console.log(`💡 Get free key: https://rapidapi.com/api-sports/api/api-football`);
});
