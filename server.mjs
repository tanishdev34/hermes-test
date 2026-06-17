import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { render } from '@react-email/render';
import React from 'react';
import { Redis } from '@upstash/redis';
import nodemailer from 'nodemailer';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const PORT = process.env.PORT || 3200;
const APP_URL = process.env.APP_URL || 'https://wc.wedevs.site';
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || process.env.SMTP_USER || '';
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 60000);

const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && ALERT_EMAIL_TO);
const deepseekConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
const mailTransport = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
}) : null;

const liveAlertState = {
  enabled: smtpConfigured && deepseekConfigured,
  running: false,
  lastRunAt: null,
  liveMatches: 0,
  lastEmailAt: null,
  lastEmailSubject: null,
  lastError: null,
  recentAlerts: [],
};

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
        commentary JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await db.query(`ALTER TABLE match_details ADD COLUMN IF NOT EXISTS commentary JSONB DEFAULT '[]';`);
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
  const result = { events: [], lineups: [], stats: [], commentary: [] };

  for (const e of data.keyEvents || []) {
    const type = e.type?.text || '';
    const typeLower = type.toLowerCase();
    if (['goal', 'yellow card', 'red card', 'substitution', 'penalty - scored', 'penalty - missed', 'kickoff', 'halftime', 'full time', 'penalty awarded', 'var'].some(t => typeLower.includes(t))) {
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

  for (const item of data.commentary || []) {
    const text = item?.text?.trim();
    if (!text) continue;
    result.commentary.push({
      sequence: Number(item.sequence ?? result.commentary.length),
      time: item.time?.displayValue || '',
      text,
    });
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

  result.commentary.sort((a, b) => a.sequence - b.sequence);
  return result;
}

// Get match detail: DB → ESPN → store in DB
async function getMatchDetail(id, { preferFresh = false } = {}) {
  const idStr = String(id);

  // 1. Check PostgreSQL unless caller asked for fresh data (live matches)
  if (!preferFresh) {
    try {
      const dbRes = await db.query('SELECT events, lineups, stats, commentary FROM match_details WHERE match_id = $1', [idStr]);
      if (dbRes.rows.length > 0) {
        const row = dbRes.rows[0];
        if ((row.events && row.events.length > 0) || (row.lineups && row.lineups.length > 0) || (row.commentary && row.commentary.length > 0)) {
          return {
            events: row.events || [],
            lineups: row.lineups || [],
            stats: row.stats || [],
            commentary: row.commentary || [],
          };
        }
      }
    } catch (e) {
      console.error('DB read error:', e.message);
    }
  }

  // 2. Fetch from ESPN
  const data = await espnFetch(`/summary?event=${id}`);
  if (!data) return null;

  const parsed = parseSummary(data);

  // 3. Store in PostgreSQL
  try {
    await db.query(
      `INSERT INTO match_details (match_id, events, lineups, stats, commentary, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (match_id) DO UPDATE SET
         events = EXCLUDED.events,
         lineups = EXCLUDED.lineups,
         stats = EXCLUDED.stats,
         commentary = EXCLUDED.commentary,
         updated_at = NOW()`,
      [idStr, JSON.stringify(parsed.events), JSON.stringify(parsed.lineups), JSON.stringify(parsed.stats), JSON.stringify(parsed.commentary)]
    );
  } catch (e) {
    console.error('DB write error:', e.message);
  }

  return parsed;
}

function mapSummaryHeaderToMatch(data) {
  const comp = data?.header?.competitions?.[0] || {};
  const teams = comp.competitors || [];
  const home = teams.find(t => t.homeAway === 'home') || {};
  const away = teams.find(t => t.homeAway === 'away') || {};
  const status = comp.status?.type?.name || '';
  const statusDetail = comp.status?.type?.shortDetail || comp.status?.type?.detail || '';
  let mappedStatus = 'upcoming';
  if (status.includes('FULL') || status.includes('FINAL')) mappedStatus = 'finished';
  else if (status.includes('HALF') || status.includes('IN_PROGRESS') || status.includes('LIVE') || status.includes('2ND') || status.includes('1ST')) mappedStatus = 'live';
  return {
    id: data?.header?.id || comp.id,
    date: comp.date || null,
    name: `${home.team?.displayName || 'Home'} vs ${away.team?.displayName || 'Away'}`,
    status: mappedStatus,
    statusDetail,
    venue: comp.venue?.fullName || '',
    home: {
      id: home.id,
      name: home.team?.displayName || '',
      shortName: home.team?.abbreviation || '',
      score: normalizeScore(home.score),
      logo: home.team?.logos?.[0]?.href || '',
    },
    away: {
      id: away.id,
      name: away.team?.displayName || '',
      shortName: away.team?.abbreviation || '',
      score: normalizeScore(away.score),
      logo: away.team?.logos?.[0]?.href || '',
    },
    group: data?.header?.season?.name || '',
  };
}

function compactStats(stats = []) {
  return (stats || []).map(team => ({
    team: team.team,
    stats: Object.fromEntries(
      Object.entries(team.stats || {}).filter(([key]) => [
        'shotsontarget', 'shots', 'possession', 'woncorners', 'yellowcards', 'redcards', 'foulscommitted'
      ].includes(key))
    ),
  }));
}

function stripCodeFences(text = '') {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBodyCopy(text = '') {
  return escapeHtml(text).replace(/\n/g, '<br/>');
}

async function renderAlertEmailHtml(decision, match, commentaryWindow) {
  const commentaryItems = commentaryWindow.slice(-5);
  const topMeta = [match.statusDetail || 'Live', match.venue || null].filter(Boolean).join(' · ');
  const scoreline = `${match.home.name} ${match.home.score ?? '?'}-${match.away.score ?? '?'} ${match.away.name}`;
  const confidencePct = `${Math.max(0, Math.min(100, Math.round(Number(decision.confidence || 0) * 100)))}%`;
  const urgency = String(decision.urgency || 'medium').toUpperCase();
  const summaryHtml = formatBodyCopy(decision.email_markdown || decision.summary || 'Interesting live update detected.');

  const E = React.createElement;
  return render(
    E('div', {
      style: {
        backgroundColor: '#f3f6fb',
        margin: 0,
        padding: '32px 16px',
        fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        color: '#0f172a',
      },
    },
      E('div', {
        style: {
          maxWidth: '640px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '24px',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(15, 23, 42, 0.12)',
          border: '1px solid #e2e8f0',
        },
      },
        E('div', {
          style: {
            padding: '28px 32px 20px',
            background: 'linear-gradient(135deg, #0f172a 0%, #111827 55%, #1d4ed8 100%)',
            color: '#ffffff',
          },
        },
          E('div', { style: { fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)', marginBottom: '14px' } }, 'WC Pulse · Live Alert'),
          E('div', { style: { fontSize: '28px', fontWeight: 800, lineHeight: 1.2, marginBottom: '12px' } }, escapeHtml(decision.subject)),
          E('div', { style: { fontSize: '16px', lineHeight: 1.5, color: 'rgba(255,255,255,0.86)' } }, scoreline),
          topMeta ? E('div', { style: { fontSize: '13px', marginTop: '10px', color: 'rgba(255,255,255,0.72)' } }, topMeta) : null,
        ),
        E('div', { style: { padding: '24px 32px 32px' } },
          E('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' } },
            E('div', { style: { padding: '10px 14px', borderRadius: '999px', backgroundColor: '#eff6ff', color: '#1d4ed8', fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' } }, urgency),
            E('div', { style: { padding: '10px 14px', borderRadius: '999px', backgroundColor: '#f8fafc', color: '#334155', fontSize: '12px', fontWeight: 700 } }, `Confidence ${confidencePct}`),
            decision.watch_for ? E('div', { style: { padding: '10px 14px', borderRadius: '999px', backgroundColor: '#f8fafc', color: '#334155', fontSize: '12px', fontWeight: 600 } }, `Watch for: ${decision.watch_for}`) : null,
          ),
          E('div', { style: { fontSize: '16px', lineHeight: 1.75, color: '#1e293b', marginBottom: '24px' }, dangerouslySetInnerHTML: { __html: summaryHtml } }),
          E('div', { style: { borderRadius: '18px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', padding: '18px 18px 8px', marginBottom: '24px' } },
            E('div', { style: { fontSize: '13px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', marginBottom: '12px' } }, 'Recent Commentary'),
            ...commentaryItems.map((item) => E('div', { style: { padding: '0 0 12px', marginBottom: '12px', borderBottom: '1px solid #e2e8f0' } },
              E('div', { style: { fontSize: '12px', fontWeight: 700, color: '#2563eb', marginBottom: '6px' } }, item.time || 'Live'),
              E('div', { style: { fontSize: '14px', lineHeight: 1.65, color: '#0f172a' } }, item.text),
            )),
          ),
          E('a', {
            href: APP_URL,
            style: {
              display: 'inline-block',
              padding: '14px 20px',
              borderRadius: '14px',
              background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
              color: '#ffffff',
              textDecoration: 'none',
              fontWeight: 700,
              fontSize: '14px',
            },
          }, 'Open WC Dashboard'),
          E('div', { style: { marginTop: '24px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 } }, 'Automated from WC Pulse using ESPN public commentary + DeepSeek analysis.'),
        ),
      ),
    ),
    { pretty: true }
  );
}

function buildAlertHash(match, decision, commentary) {
  const payload = JSON.stringify({
    matchId: match.id,
    score: `${match.home.score}-${match.away.score}`,
    statusDetail: match.statusDetail,
    subject: decision.subject,
    commentary: (commentary || []).map(item => item.sequence),
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function fallbackAlertDecision(match, commentary = [], events = []) {
  const recentText = commentary.map(item => item.text).join(' | ');
  const combined = `${recentText} | ${(events || []).slice(-3).map(e => e.detail).join(' | ')}`.toLowerCase();
  const urgent = /(goal|penalty|red card|sent off|var check|var overturn|equali[sz]er|winner|lead|save|crossbar|post)/i.test(combined);
  const subject = `[WC Pulse] ${match.home.name} ${match.home.score ?? '?'}-${match.away.score ?? '?'} ${match.away.name} · ${match.statusDetail || 'Live update'}`;
  const lead = commentary[commentary.length - 1]?.text || events[events.length - 1]?.detail || 'Interesting live update detected.';
  return {
    send: urgent,
    urgency: urgent ? 'high' : 'low',
    subject,
    summary: lead,
    confidence: urgent ? 0.72 : 0.35,
    watch_for: 'Momentum swings, set pieces, and disciplinary events.',
    email_markdown: `${match.home.name} ${match.home.score ?? '?'}-${match.away.score ?? '?'} ${match.away.name} (${match.statusDetail || 'Live'})\n\n${lead}`,
  };
}

async function analyzeInterestingMoment(match, detail, commentaryWindow) {
  const fallback = fallbackAlertDecision(match, commentaryWindow, detail.events || []);
  if (!deepseekConfigured) return fallback;

  const payload = {
    match: {
      id: match.id,
      home: match.home.name,
      away: match.away.name,
      homeScore: match.home.score,
      awayScore: match.away.score,
      status: match.status,
      statusDetail: match.statusDetail,
      venue: match.venue,
      tournamentStage: match.group,
    },
    recentCommentary: commentaryWindow.slice(-8),
    recentEvents: (detail.events || []).slice(-6),
    stats: compactStats(detail.stats || []),
  };

  const messages = [
    {
      role: 'system',
      content: 'You are a live football alert analyst. Decide whether a new commentary update is interesting enough to email immediately. Send emails only for meaningful moments: goals, penalties, red cards, VAR decisions, major chances/saves, intense momentum suggesting a goal may happen soon, halftime/fulltime if dramatic. Ignore routine possession, throw-ins, ordinary substitutions, and low-signal chatter. Return strict JSON with keys send, urgency, subject, summary, confidence, watch_for, email_markdown.',
    },
    {
      role: 'user',
      content: `Analyze this live football update and decide if it deserves an immediate email alert. JSON only.\n${JSON.stringify(payload)}`,
    },
  ];

  try {
    const res = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(stripCodeFences(raw));
    return {
      send: Boolean(parsed.send),
      urgency: parsed.urgency || 'medium',
      subject: parsed.subject || fallback.subject,
      summary: parsed.summary || fallback.summary,
      confidence: Number(parsed.confidence || 0),
      watch_for: parsed.watch_for || '',
      email_markdown: parsed.email_markdown || fallback.email_markdown,
    };
  } catch (e) {
    liveAlertState.lastError = `DeepSeek analysis failed: ${e.message}`;
    return fallback;
  }
}

async function sendAlertEmail(decision, match, commentaryWindow) {
  if (!mailTransport || !ALERT_EMAIL_TO) return { sent: false, reason: 'smtp_not_configured' };
  const lines = [
    `${match.home.name} ${match.home.score ?? '?'}-${match.away.score ?? '?'} ${match.away.name}`,
    `${match.statusDetail || 'Live'}${match.venue ? ` · ${match.venue}` : ''}`,
    '',
    decision.summary || '',
    decision.watch_for ? `Watch for: ${decision.watch_for}` : '',
    '',
    'Recent commentary:',
    ...commentaryWindow.slice(-5).map(item => `- ${item.time ? `${item.time} ` : ''}${item.text}`),
    '',
    `Open dashboard: ${APP_URL}`,
  ].filter(Boolean);

  const html = await renderAlertEmailHtml(decision, match, commentaryWindow);

  const info = await mailTransport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: ALERT_EMAIL_TO,
    subject: decision.subject,
    text: lines.join('\n'),
    html,
  });

  liveAlertState.lastEmailAt = new Date().toISOString();
  liveAlertState.lastEmailSubject = decision.subject;
  liveAlertState.recentAlerts = [
    { at: liveAlertState.lastEmailAt, subject: decision.subject, matchId: match.id, score: `${match.home.score ?? '?'}-${match.away.score ?? '?'}` },
    ...liveAlertState.recentAlerts,
  ].slice(0, 10);

  return { sent: true, messageId: info.messageId };
}

async function processLiveMatchAlerts(match) {
  const data = await espnFetch(`/summary?event=${match.id}`);
  if (!data) return { skipped: true, reason: 'summary_unavailable' };

  const detail = parseSummary(data);
  const commentary = detail.commentary || [];
  const latestSeq = commentary.length ? commentary[commentary.length - 1].sequence : -1;
  const seqKey = `wc:commentary:last-seq:${match.id}`;
  const lastSeqRaw = await redisGet(seqKey);

  if (lastSeqRaw === null || lastSeqRaw === undefined) {
    await redisSet(seqKey, latestSeq, 24 * 3600);
    return { skipped: true, reason: 'initialized' };
  }

  const lastSeq = Number(lastSeqRaw);
  const newCommentary = commentary.filter(item => item.sequence > lastSeq);
  if (!newCommentary.length) return { skipped: true, reason: 'no_new_commentary' };

  await redisSet(seqKey, latestSeq, 24 * 3600);
  const decision = await analyzeInterestingMoment(match, detail, newCommentary);
  if (!decision.send) return { skipped: true, reason: 'not_interesting', decision };

  const alertHash = buildAlertHash(match, decision, newCommentary);
  const alertKey = `wc:alert:sent:${alertHash}`;
  if (await redisGet(alertKey)) return { skipped: true, reason: 'duplicate', decision };

  const email = await sendAlertEmail(decision, match, newCommentary);
  if (email.sent) {
    await redisSet(alertKey, { at: new Date().toISOString(), subject: decision.subject }, 7 * 24 * 3600);
  }
  return { skipped: !email.sent, reason: email.sent ? 'sent' : (email.reason || 'email_failed'), decision, email };
}

async function monitorLiveCommentary() {
  if (liveAlertState.running || !liveAlertState.enabled) return;
  liveAlertState.running = true;
  liveAlertState.lastError = null;
  try {
    const data = await espnFetch('/scoreboard');
    const liveMatches = (data?.events || []).map(mapEvent).filter(match => match.status === 'live');
    liveAlertState.liveMatches = liveMatches.length;
    for (const match of liveMatches) {
      await processLiveMatchAlerts(match);
    }
  } catch (e) {
    liveAlertState.lastError = e.message;
  } finally {
    liveAlertState.lastRunAt = new Date().toISOString();
    liveAlertState.running = false;
  }
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
  const preferFresh = c.req.query('live') === '1';
  const detail = await getMatchDetail(id, { preferFresh });
  if (detail) return c.json(detail);
  return c.json({ error: 'Match not found' }, 404);
});

app.get('/api/alerts/status', async (c) => {
  return c.json({
    ok: true,
    enabled: liveAlertState.enabled,
    smtpConfigured,
    deepseekConfigured,
    pollMs: ALERT_POLL_MS,
    lastRunAt: liveAlertState.lastRunAt,
    liveMatches: liveAlertState.liveMatches,
    lastEmailAt: liveAlertState.lastEmailAt,
    lastEmailSubject: liveAlertState.lastEmailSubject,
    lastError: liveAlertState.lastError,
    recentAlerts: liveAlertState.recentAlerts,
    provider: deepseekConfigured ? { api: 'deepseek', model: DEEPSEEK_MODEL } : null,
    freeCommentarySource: 'ESPN public summary commentary feed',
  });
});

app.get('/api/alerts/test/:id', async (c) => {
  const id = c.req.param('id');
  const shouldSend = c.req.query('send') === '1';
  const data = await espnFetch(`/summary?event=${id}`);
  if (!data) return c.json({ error: 'Summary not found' }, 404);
  const match = mapSummaryHeaderToMatch(data);
  const detail = parseSummary(data);
  const commentaryWindow = (detail.commentary || []).slice(-8);
  const decision = await analyzeInterestingMoment(match, detail, commentaryWindow);
  let email = { sent: false, reason: 'send_not_requested' };
  if (shouldSend) {
    const forcedDecision = {
      ...decision,
      send: true,
      subject: `[TEST] ${decision.subject || `[WC Pulse] ${match.home.name} vs ${match.away.name}`}`,
    };
    email = await sendAlertEmail(forcedDecision, match, commentaryWindow);
  }
  return c.json({ match, decision, email, commentaryCount: detail.commentary?.length || 0 });
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
  return c.json({
    ok: true,
    redis: redisOk,
    postgres: pgOk,
    source: 'ESPN',
    port: PORT,
    alerts: {
      enabled: liveAlertState.enabled,
      smtpConfigured,
      deepseekConfigured,
      lastRunAt: liveAlertState.lastRunAt,
      lastEmailAt: liveAlertState.lastEmailAt,
      liveMatches: liveAlertState.liveMatches,
    },
  });
});

// Static files
app.use('/*', serveStatic({ root: './dist' }));

// SPA fallback
app.get('*', async (c) => {
  const html = await readFile(join(DIST, 'index.html'), 'utf-8');
  return c.html(html);
});

if (liveAlertState.enabled) {
  setTimeout(() => {
    monitorLiveCommentary().catch((e) => { liveAlertState.lastError = e.message; });
  }, 15000);
  setInterval(() => {
    monitorLiveCommentary().catch((e) => { liveAlertState.lastError = e.message; });
  }, ALERT_POLL_MS);
}

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`⚽ WC 2026 — The Pulse`);
  console.log(`🚀 http://0.0.0.0:${info.port}`);
  console.log(`📡 Data: ESPN public API`);
  console.log(`🗄️  Cache: Redis + PostgreSQL`);
  console.log(`💡 Live matches pinned to top`);
  if (liveAlertState.enabled) console.log(`📬 AI live commentary alerts enabled → ${ALERT_EMAIL_TO}`);
});
