# FastF1 Interactive F1 Dashboard Implementation Plan

> **For Hermes / implementation AI:** Use `/opt/data/wc-app/docs/F1_FASTF1_INTERACTIVE_SPEC.md` as the canonical product/API spec. This file is the live implementation-status plan and should be updated after every implementation pass.

**Goal:** Upgrade the existing Astro + Hono F1 section from Jolpica-only/static charts to a fast, progressive, interactive FastF1-powered race analysis dashboard.

**Architecture:** Keep Jolpica as the fast fallback/season overview source. Keep FastF1 in the separate Python backend, materialize processed JSON files asynchronously, proxy those files through Hono, and progressively/lazily load heavy UI tabs.

**Tech Stack:** Astro, inline browser JS/canvas, Hono Node server, Python FastF1/Pandas backend, Redis for small response caches, PostgreSQL for WC match details.

**Last audit:** 2026-06-16 15:14 UTC

**Continued implementation pass:** 2026-06-16 15:22 UTC

---

## Current Verification Snapshot

Commands run from `/opt/data/wc-app` during this audit:

- `npm run build` ✅ passed; Astro built 2 static pages successfully.
- `python3 -m py_compile f1_server.py` ✅ passed.
- `curl http://127.0.0.1:3200/api/status` ⚠️ failed because the Hono server was not running locally.
- `curl http://127.0.0.1:4000/health` ⚠️ failed because the FastF1 Python server was not running locally.
- `git -c safe.directory=/opt/data/wc-app status --short` showed many existing modified/untracked files, including this plan under `.hermes/` and the spec under `docs/`.

No end-to-end API/browser smoke test was possible in this audit because local services were not running.

---

## What Is Already Done

### Phase 0 — Safety and Baseline

- ✅ `.env` is listed in `.gitignore`.
- ✅ World Cup API/frontend code still exists and was not replaced by the F1 work.
- ✅ Static Astro build passes.
- ⚠️ API response shapes were not recaptured in this audit because neither local server was running.
- ⚠️ Git history/secrets audit was not performed here; do that before commit/push.

### Phase 1 — Python FastF1 Cache Service (`f1_server.py`)

Implemented:

- ✅ Persistent processed cache root via `F1_PROCESSED_CACHE`, defaulting to `data/f1-cache`.
- ✅ Atomic JSON writes via `write_json_atomic()`.
- ✅ Manifest/status endpoint: `/race/:year/:round/manifest`.
- ✅ Background prepare endpoint: `POST /race/:year/:round/prepare`.
- ✅ Duplicate prepare guard using `_jobs` tracking.
- ✅ Summary-first load attempt with `telemetry=False`, then telemetry reload later.
- ✅ Writes `summary.json`, `results.json`, `laps.json`, `strategy.json`, `weather.json`, `race_control.json`.
- ✅ Writes `telemetry_index.json`, `telemetry/*.json` for fastest laps, and `track_map.json` when telemetry/position data is available.
- ✅ CORS and JSON response helper are present.
- ✅ Health endpoint exists at `/health`.

Partially done / needs hardening:

- ⚠️ Extraction steps are not isolated enough. If `extract_results`, `extract_laps`, `extract_strategy`, etc. throw unexpectedly, the full prepare job can still fail instead of recording a warning and continuing.
- ⚠️ Telemetry files are only pre-generated for fastest laps. The UI exposes arbitrary driver/lap combos from the index, but `/telemetry?driver=&lap=` only returns already-written files and does not generate missing selections on demand.
- ⚠️ `track_map.json` points currently only contain `x`/`y`; the frontend has a speed overlay path, but `extract_track_map()` never includes `speed`.
- ⚠️ Manifest progress/status handling should include every transient status consistently, including `queued`.

### Phase 2 — Hono Proxy and Fallback (`server.mjs`)

Implemented:

- ✅ `fastf1Fetch()` helper exists with an 8s timeout.
- ✅ Old `/api/f1/race/:year/:round` tries FastF1 first and falls back to Jolpica.
- ✅ Old race endpoint includes `fastf1_status`, `fastf1_ready`, `fastf1_source`, and `detail_endpoints` in fallback responses.
- ✅ New proxy endpoints exist:
  - `/api/f1/race/:year/:round/manifest`
  - `/api/f1/race/:year/:round/prepare`
  - `/api/f1/race/:year/:round/laps`
  - `/api/f1/race/:year/:round/strategy`
  - `/api/f1/race/:year/:round/weather`
  - `/api/f1/race/:year/:round/race-control`
  - `/api/f1/race/:year/:round/track-map`
  - `/api/f1/race/:year/:round/telemetry-index`
  - `/api/f1/race/:year/:round/telemetry?driver=&lap=`
- ✅ Jolpica fallback uses a higher lap limit (`limit=3000`).

Partially done / needs fixes:

- ⚠️ `F1_BACKEND` is hard-coded to `http://127.0.0.1:4000`; it should read `process.env.F1_BACKEND || 'http://127.0.0.1:4000'`.
- ⚠️ `/api/f1/season/:year` does not attach `fastf1_status` to race cards, but the frontend checks `race.fastf1_status` and tries to render cache badges.
- ⚠️ Race fallback responses are cached for 6 hours even when `fastf1_status` is `missing`, `offline`, or `running`; this can make the UI stale after preparation finishes.
- ⚠️ `/api/f1/race/:year/:round/manifest` always returns JSON without preserving failed backend status codes.
- ⚠️ Small manifest/summary Redis caching from the spec is not implemented intentionally/explicitly; current caching only covers season and old race detail.
- ⚠️ Python FastF1 race responses do not include `year`/`round`, and the Hono fallback response also omits them. The frontend telemetry loader depends on those fields and currently falls back incorrectly.

### Phase 3 — Frontend Race Modal Progressive Loading (`src/pages/index.astro`)

Implemented:

- ✅ Opens modal with initial race detail from `/api/f1/race/:year/:round`.
- ✅ Shows FastF1/Jolpica source badge.
- ✅ Prepare panel UI exists.
- ✅ `startPrepare()` calls the prepare endpoint.
- ✅ Manifest polling exists and refreshes race data once `ready` or `summary_ready` appears.
- ✅ Heavy tabs are lazy-loaded on tab click.
- ✅ Telemetry tab fetches selected telemetry only, not all telemetry on modal open.

Partially done / needs fixes:

- ⚠️ Spec says if FastF1 is not ready, show preparation panel and call prepare. Current code only shows a **Prepare Data** button; it does not auto-start preparation.
- ⚠️ Polling starts on an interval but does not perform an immediate manifest fetch, so the UI can sit idle for up to 3 seconds.
- ⚠️ `manifestPollTimer` is not cleared in `closeF1()`.
- ⚠️ `reloadF1RaceData()` updates results/strategy but does not refresh all existing tab data or redraw lap-time/track/telemetry states robustly.
- ❌ Critical bug: `loadTelemetry()` defaults to `2026/1` because the app is on `/`, `raceData.year`/`raceData.round` are absent, and `location.pathname` has no race route. Telemetry for any race except 2026 round 1 will request the wrong endpoint.

### Phase 4 — Fix and Upgrade Lap Chart

Implemented:

- ✅ Race replay canvas exists.
- ✅ Play/pause, reset, scrubber, and replay speed controls exist.
- ✅ Top 10/all modes exist.
- ✅ Driver search/highlight exists.
- ✅ Dynamic y-axis domain is used for top 10 vs all drivers.
- ✅ Lap leaderboard table is synced to the current replay lap.
- ✅ Empty text is drawn when lap-time data is missing.

Partially done / needs fixes:

- ⚠️ Driver key normalization is still incomplete. Jolpica fallback uses `driverId.substring(0,3).toUpperCase()`, which can mismatch real FastF1 abbreviations/result abbreviations.
- ⚠️ Lap chart hover tooltip from the spec is not implemented for the race replay chart; only the lap-time chart has a tooltip.
- ⚠️ Source/empty/error badges are minimal; blank/near-blank canvases are still possible in some failure states.
- ⚠️ `drawLapChart()` should guard `maxPos <= 1` to avoid divide-by-zero edge cases.

### Phase 5 — Strategy + Lap Times

Implemented:

- ✅ FastF1 strategy extraction uses real `Compound`, `Stint`, `TyreLife`, pit-in/out data when prepared.
- ✅ Fallback strategy exists from Jolpica pit stops.
- ✅ Lap-time chart exists with compound-colored points.
- ✅ Lap-time filters exist for pit laps and deleted laps.
- ✅ Lap-time driver search/highlight exists.
- ✅ Lap-time tooltip includes sectors, compound, tyre life, and lap time.

Partially done / needs fixes:

- ⚠️ Jolpica fallback strategy still guesses compounds (`SOFT`/`MEDIUM`/`HARD`) because Jolpica does not provide real tyre data. Make this explicit as a fallback-only approximation in UI, or remove compound labels until FastF1 is ready.
- ⚠️ Safety-car/track-status filtering is not implemented in the lap-time UI.
- ❌ Lap-time tab does not reliably draw on first open. `loadLapTimesTab()` only ensures lap data is loaded; it never calls `drawLapTimes()` after loading, and returns early if `f1State.lapsData` already exists.

### Phase 6 — Telemetry Compare + Track Map

Implemented:

- ✅ Telemetry selector UI exists for Driver A and optional Driver B.
- ✅ Fetches selected telemetry files only.
- ✅ Draws multi-channel telemetry traces: speed, throttle, brake, gear.
- ✅ Supports two-driver/lap compare visually.
- ✅ Synchronized cursor from telemetry hover redraws track map.
- ✅ Track map canvas exists with playback dot support from telemetry samples.
- ✅ Track map playback/scrubber exists.

Partially done / needs fixes:

- ❌ Critical bug inherited from Phase 3: telemetry fetches default to `/api/f1/race/2026/1/...` unless `raceData.year` and `raceData.round` are included.
- ⚠️ Backend only serves pre-generated fastest-lap telemetry files; most selectable driver/lap combos from `telemetry_index` will 404.
- ⚠️ Track map speed overlay code exists but backend does not include speed in track map points.
- ⚠️ Telemetry chart does not display an explicit error if a selected telemetry file returns 404; it just leaves the canvas instruction/empty state.
- ⚠️ Track-map playback depends on telemetry loaded in the telemetry tab; standalone track-map tab has no driver/lap selector.

### Phase 7 — Validation and Deployment

Done:

- ✅ Static Astro build passes.
- ✅ Python syntax compile passes.

Missing:

- ❌ Run Hono server locally and smoke test `/api/status`, `/api/f1/season/2026`, `/api/f1/race/2026/1`.
- ❌ Run FastF1 Python backend locally and smoke test `/health`, `/race/2026/1/manifest`, and `POST /race/2026/1/prepare`.
- ❌ Test a finished race with known FastF1 data after cache generation.
- ❌ Test a future race and a missing/unprepared race.
- ❌ Test Python backend offline fallback from Hono.
- ❌ Test first-load cache generation and second-load fast path.
- ❌ Test mobile modal layout.
- ❌ Restart deployed services and verify production after fixes.

---

## Highest-Priority Remaining Work

### Status snapshot after continued implementation pass

**Completed in this pass:**

- ✅ P0 — race identity propagation fixed in Python backend, Hono backend, and frontend telemetry loader.
- ✅ P1 — stale race-detail cache fixed by using a short fallback TTL and ready-only long TTL.
- ✅ P2 — `F1_BACKEND` now configurable via environment variable.
- ✅ P4 — Lap Times tab now draws on first open.

**Next priority items:**

- ✅ P3 — season-card `fastf1_status`/badge logic implemented via live FastF1 manifest lookup.
- ✅ P5 — auto-start FastF1 prepare implemented for missing/offline races.
- ✅ P6 — partial-extraction hardening implemented in Python FastF1 preparation.
- 🔜 P7 — telemetry index accuracy / on-demand generation.
- 🔜 P8–P10 — remaining polish, filters, smoke tests, and deploy verification.

### P0 — Fix race identity propagation for telemetry

**Why:** Current telemetry requests can target the wrong race.

**Files:**

- Modify: `f1_server.py`
- Modify: `server.mjs`
- Modify: `src/pages/index.astro`

**Steps:**

1. Add `year` and `round` to every FastF1 main race detail response in `f1_server.py`.
2. Add `year: parseInt(year)` and `round: parseInt(round)` to the Jolpica fallback race detail in `server.mjs`.
3. In `openF1Race(year, round)`, store `f1State.year = year` and `f1State.round = round` or include them in `raceData` before rendering.
4. In `loadTelemetry()`, use the stored modal `year/round`; remove the `location.pathname` fallback.
5. Verify by opening a non-round-1 race and confirming telemetry calls use that race's URL.

### P1 — Fix stale Redis caching for race detail status

**Why:** Current fallback race detail can cache `missing/offline/running` for 6 hours and hide newly prepared FastF1 data.

**Files:**

- Modify: `server.mjs`

**Steps:**

1. Do not cache `/api/f1/race/:year/:round` fallback responses when `fastf1_status` is `missing`, `offline`, `running`, `queued`, or any transient job status.
2. Use short TTL only for `summary_ready`/`ready` FastF1 responses.
3. If caching fallback is needed, use a very short TTL such as 30-60s.
4. Verify: call race endpoint before prepare, start prepare, wait ready, call race endpoint again and confirm FastF1 data is served.

### P2 — Make `F1_BACKEND` configurable

**Why:** Deployment/staging should not require code edits.

**Files:**

- Modify: `server.mjs`
- Optionally update deployment `.env` outside git.

**Change:**

```js
const F1_BACKEND = process.env.F1_BACKEND || 'http://127.0.0.1:4000';
```

### P3 — Attach FastF1 status to season cards or remove the badge logic

**Why:** Frontend checks `race.fastf1_status`, but Hono season endpoint never supplies it.

**Files:**

- Modify: `server.mjs`
- Modify if needed: `src/pages/index.astro`

**Options:**

1. Preferred: call FastF1 manifest/status for finished races with a tight timeout and attach `fastf1_status` to each race card.
2. Alternative: remove badge logic from season cards and rely only on modal status.

### P4 — Fix lap-time tab rendering

**Why:** The Lap Times tab can stay blank until a user changes a filter.

**Files:**

- Modify: `src/pages/index.astro`

**Change outline:**

```js
async function loadLapTimesTab(year, round) {
  if (!f1State.lapsData) await loadLapsTab(year, round);
  drawLapTimes();
}
```

Also call `drawLapTimes()` after `loadLapsTab()` if the lap-time tab is currently active.

### P5 — Auto-start or clearly gate FastF1 preparation

**Why:** Spec says the UI should call prepare when not ready; current UI requires a manual button click.

**Files:**

- Modify: `src/pages/index.astro`

**Decision needed:**

- If automatic backend work is acceptable: call `startPrepare(year, round)` after showing the panel for `missing/offline` except when backend is offline.
- If manual control is desired: update the spec/UX copy and make the button state clearer.

### P6 — Harden Python extraction so partial data survives

**Why:** One failing dataset should not fail the whole cache job.

**Files:**

- Modify: `f1_server.py`

**Steps:**

1. Wrap each extraction/write block in its own `try/except`.
2. Append warnings to manifest for failed sections.
3. Continue to write available sections.
4. Set `available.*` booleans based on real successful writes.
5. Verify by temporarily forcing a telemetry/track-map failure and confirming results/laps/strategy still become available.

### P7 — Support on-demand telemetry file generation or restrict selectors

**Why:** The index advertises many driver/lap combos, but backend only materializes fastest-lap files.

**Files:**

- Modify: `f1_server.py`
- Modify: `src/pages/index.astro`

**Options:**

1. Preferred: add on-demand telemetry generation endpoint behavior for missing `driver/lap` selections.
2. Simpler: only expose pre-generated telemetry combos in `telemetry_index` until on-demand generation exists.
3. Always show a clear error when a selected telemetry file is unavailable.

### P8 — Finish lap replay UX polish

**Files:**

- Modify: `src/pages/index.astro`

**Tasks:**

1. Add hover tooltip for race replay canvas.
2. Normalize driver keys via a shared function/mapping instead of `substring(0,3)`.
3. Add stronger empty/error/source badges for each chart.
4. Guard divide-by-zero cases in canvas scaling.

### P9 — Complete remaining strategy/lap-time filters

**Files:**

- Modify: `src/pages/index.astro`

**Tasks:**

1. Add safety-car/track-status filter to lap-time chart.
2. Add selected-driver multi-select or clearer driver filter UX.
3. Mark Jolpica fallback tyre compounds as estimated, or hide compounds in fallback strategy.

### P10 — Full validation/deploy pass

**Files/commands:**

- `npm run build`
- `python3 -m py_compile f1_server.py`
- Start FastF1 backend: `F1_PORT=4000 python3 f1_server.py`
- Start Hono server: `PORT=3200 F1_BACKEND=http://127.0.0.1:4000 node server.mjs`
- Smoke:
  - `curl -sS http://127.0.0.1:4000/health`
  - `curl -sS http://127.0.0.1:3200/api/status`
  - `curl -sS http://127.0.0.1:3200/api/f1/season/2026`
  - `curl -sS http://127.0.0.1:3200/api/f1/race/2026/1`
  - `curl -sS -X POST http://127.0.0.1:3200/api/f1/race/2026/1/prepare`
  - poll `http://127.0.0.1:3200/api/f1/race/2026/1/manifest`
- Browser-smoke the modal on desktop and mobile widths.
- Verify Python backend offline fallback.
- Only then restart deployed services.

---

## Key Non-Negotiables

- Do not commit secrets.
- Do not commit `.env`, Redis tokens, DB URLs, API keys, or generated credential files.
- Do not block the modal on full FastF1 telemetry generation.
- Do not show blank charts; show data source/error/empty states.
- Do not guess tyre compounds once FastF1 data is available.
- Do not load all telemetry for all drivers/laps on modal open.
- Keep Jolpica fallback and WC dashboard working.
