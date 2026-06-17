# F1 FastF1 Interactive Dashboard Spec

> **For the implementation AI:** This is a documentation/spec-only handoff. Do not treat the current code as final architecture. Use this spec to implement a faster, richer FastF1-powered F1 section in the existing Astro + Hono app without breaking the World Cup section.

**User goal:** Replace the weak/low-data Jolpica-only F1 race detail experience with richer FastF1 data, while keeping pages fast. The current lap chart often shows nothing because the app mostly serves Jolpica position-only data and the FastF1 backend is too slow/underused.

**Hard constraints:**
- Keep credentials/secrets out of git. Use `.env` only, and ensure `.env` is gitignored.
- Do not make FastF1 first-load latency block the core UI.
- Jolpica can remain the fast fallback for season overview/results, but detailed analysis should be enriched from FastF1 once warmed/cached.
- FastF1 backend may fail or be slow; app must degrade gracefully.
- World Cup/ESPN functionality must continue working.

---

## 1. Current App Context

Repository: `/opt/data/wc-app`

Relevant files observed:
- `server.mjs` — Hono server on port `3200`; serves static Astro build; has WC ESPN endpoints and F1 endpoints.
- `f1_server.py` — simple Python HTTP server on `127.0.0.1:4000`; uses FastF1 with in-memory cache only.
- `src/pages/index.astro` — home dashboard and inline client JS for WC and F1 rendering.
- `src/layouts/Layout.astro` — global CSS including F1 card/table/modal styles.
- `package.json` — Astro + Hono + Upstash Redis + pg.

Current F1 data flow:

```text
Browser
  -> Hono /api/f1/season/:year
      -> Jolpica results + standings only
  -> Hono /api/f1/race/:year/:round
      -> Jolpica results + laps + pitstops
      -> returns guessed tire strategy, no real weather, no real race control, no real telemetry

Separate Python FastF1 backend exists at 127.0.0.1:4000, but Hono race endpoint currently does not call it.
```

Current F1 UI:
- Season grid cards.
- Race modal tabs: Results, Lap Chart, Strategy, Telemetry, Fastest Lap, Weather, Race Control.
- Lap chart is a static `<canvas>` line chart using `data.laps` `{ driver, lap, position }`.
- Telemetry chart is static `<canvas>` for speed/throttle/brake arrays.

Problem areas:
- Jolpica lap data is position-only and sometimes maps poorly to driver abbreviations, so lap chart can be blank or misleading.
- Jolpica does not provide real FastF1-level data: compounds per stint, tyre life, sectors, weather, race control, car telemetry, position telemetry, track map.
- `f1_server.py` loads full telemetry via `session.load(laps=True, telemetry=True, weather=True, messages=True)` on a race request. First load can take 10–60s and can time out or feel dead.
- FastF1 cache is only in-process memory plus `/tmp/fastf1_cache`; if the process restarts, JSON responses need to be rebuilt.

---

## 2. FastF1 Capabilities to Use

From FastF1 docs (`https://docs.fastf1.dev/`): FastF1 exposes F1 lap timing, car telemetry, position data, tyre data, weather data, event schedule, session results, race control messages, and caching.

Key API objects:
- `fastf1.get_event_schedule(year, include_testing=False)` — season schedule.
- `fastf1.get_event(year, gp)` — event metadata by year and round/name.
- `event.get_race()` or `fastf1.get_session(year, gp, 'R')` — race session.
- `session.load(laps=True, telemetry=True, weather=True, messages=True)` — loads data.
- `session.results` — classification/result table.
- `session.laps` — extended Pandas dataframe of all driver laps.
- `session.weather_data` — weather samples.
- `session.race_control_messages` — flag/safety-car/penalty/control messages.
- `session.car_data[driver_number]` — telemetry time series for each driver.
- `session.pos_data[driver_number]` — car position time series.
- `session.get_circuit_info()` — circuit/corner annotations where available.
- `Lap.get_car_data()` — speed/RPM/gear/throttle/brake/DRS for one lap.
- `Lap.get_pos_data()` — x/y/z position samples for one lap.
- `Laps.pick_drivers('VER')`, `pick_fastest()`, group by `Stint`, etc.

Important `session.laps` fields to expose:
- `Driver`, `DriverNumber`, `LapNumber`, `Position`
- `LapTime`, `Sector1Time`, `Sector2Time`, `Sector3Time`
- `Stint`, `PitOutTime`, `PitInTime`
- `Compound`, `TyreLife`, `FreshTyre`
- `SpeedI1`, `SpeedI2`, `SpeedFL`, `SpeedST`
- `IsPersonalBest`, `Deleted`, `DeletedReason`, `TrackStatus`
- `Team`, if available in FastF1 version/session

Telemetry fields to expose:
- `Time`, `SessionTime`, `Distance` when available
- `Speed`, `RPM`, `nGear`, `Throttle`, `Brake`, `DRS`
- Position data: `X`, `Y`, `Z`, plus `Time`/`SessionTime`

FastF1 examples to mirror:
- Position changes during a race.
- Driver lap time scatterplot.
- Lap time distribution.
- Tyre strategies during a race.
- Team pace comparison.
- Overlaying speed traces of two laps.
- Gear shifts on track.
- Speed visualization on track map.
- Track map with numbered corners.
- Qualifying/results overview.
- Standings heatmap/season summary.

---

## 3. Desired Product Experience

The F1 section should feel like a lightweight interactive pit wall, not a static table.

### 3.1 Season View

Keep the current race-card grid, but enrich it:
- Race status badge: `Finished`, `Upcoming`, `This week`, `Sprint weekend` if schedule data exposes sprint sessions.
- Winner and podium for finished races.
- Fastest lap winner if available from Jolpica/FastF1 cache.
- Small sparkline/mini race trace for finished races when cached.
- `Analyze` button state:
  - `Instant` if FastF1 JSON cache exists.
  - `Prepare data` if not cached.
  - `Unavailable` if future race or FastF1 cannot load.

### 3.2 Race Modal Tabs

Recommended final tabs:

1. **Overview**
   - Winner, podium, fastest lap, total laps, safety-car/VSC count, rain yes/no.
   - Track/circuit name, date, total classified drivers.
   - Mini timeline of race-defining moments: starts, safety car, red flag, major penalties, fastest lap.

2. **Race Replay**
   - Interactive lap-by-lap position chart with play/pause/scrubber.
   - Current lap marker moves over chart.
   - Leaderboard updates for selected lap.
   - Highlight driver on hover/click.
   - Filter: top 10, all, team, selected drivers.

3. **Lap Times**
   - Scatter/line chart of lap times by driver.
   - Toggles: show/hide pit laps, deleted laps, safety-car laps, wet laps.
   - Hover tooltip: driver, lap, lap time, compound, tyre age, sector times, track status.
   - Driver search box.

4. **Strategy**
   - Real tyre stints from FastF1 `Stint`, `Compound`, `TyreLife`.
   - Pit stop markers from `PitInTime`/`PitOutTime` and/or stint boundaries.
   - Compound colors: Soft red, Medium yellow, Hard white, Intermediate green, Wet blue.
   - Tooltip: `Driver`, `Compound`, `Laps`, `Start/End lap`, `Tyre age`, `Fresh tyre`.

5. **Telemetry Compare**
   - Select Driver A + lap, Driver B + lap.
   - Quick presets: fastest lap, teammate fastest laps, winner vs P2, selected driver best vs average.
   - Overlay speed, throttle, brake, gear, RPM, DRS vs distance.
   - Synchronized hover cursor across all charts and track map.
   - Delta trace if two laps are selected.

6. **Track Map**
   - Track outline from FastF1 position data.
   - Playback dot(s) with play/pause/reset and scrubber.
   - Color track by speed or gear.
   - Optional corner numbers from `session.get_circuit_info()`.
   - For compare mode: two moving dots with time delta display.

7. **Weather**
   - Air temp, track temp, humidity, wind speed over session time/lap.
   - Rainfall markers.
   - Overlay weather events against lap times if possible.

8. **Race Control**
   - Chronological messages from `session.race_control_messages`.
   - Group/filter by flags, safety car, penalties, investigations.
   - Clicking a message jumps Race Replay/Lap Times to that approximate lap/time.

---

## 4. Performance Architecture

### 4.1 Core Rule

**Never make the first modal open wait for full FastF1 telemetry.**

Use a two-tier data model:

```text
Tier 1: Fast summary, always quick
- Jolpica fallback + cached FastF1 summary
- Results, schedule, basic lap position chart
- Response target: < 1 second from Redis/Postgres/file cache

Tier 2: Heavy enrichment, async/warmed
- Full FastF1 laps, strategy, telemetry, track map, weather, race control
- First generation may take 10–60s
- Response target after warm cache: < 500ms for JSON files, < 2s for filtered telemetry
```

### 4.2 Recommended Cache Layers

Use three cache layers:

1. **FastF1 HTTP cache**
   - Keep `FASTF1_CACHE=/tmp/fastf1_cache` or project-local cache dir.
   - This speeds repeated upstream API calls but does not remove JSON processing cost.

2. **Materialized JSON cache**
   - Save processed race datasets to disk or object storage.
   - Suggested local path: `data/f1-cache/{year}/{round}/`.
   - These files are not secrets. They can be regenerated.
   - Do **not** commit huge generated cache files unless intentionally desired.

3. **Redis metadata cache**
   - Store short status objects and small summaries.
   - Example keys:
     - `f1:race:{year}:{round}:status`
     - `f1:race:{year}:{round}:summary`
     - `f1:season:{year}`

### 4.3 Materialized Files

For each race, generate:

```text
data/f1-cache/{year}/{round}/manifest.json
summary.json
results.json
laps.json
strategy.json
position_series.json
weather.json
race_control.json
telemetry_index.json
telemetry/{DRIVER}_{LAP}.json
track_map.json
```

`manifest.json`:

```json
{
  "year": 2026,
  "round": 1,
  "session": "R",
  "status": "ready",
  "generated_at": "2026-06-16T00:00:00Z",
  "fastf1_version": "3.8.3",
  "event_name": "Bahrain Grand Prix",
  "cache_schema_version": 1,
  "available": {
    "results": true,
    "laps": true,
    "strategy": true,
    "weather": true,
    "race_control": true,
    "position_series": true,
    "track_map": true,
    "telemetry": true
  },
  "warnings": []
}
```

### 4.4 Async Preparation Flow

Recommended API behavior:

```text
User opens race modal
  -> GET /api/f1/race/:year/:round/summary
      returns instant cached summary or Jolpica fallback
  -> GET /api/f1/race/:year/:round/manifest
      if ready: frontend fetches detailed endpoints
      if missing: frontend shows "Preparing FastF1 data" and calls POST /api/f1/race/:year/:round/prepare

Prepare endpoint
  -> starts background job/process/thread if not already running
  -> returns 202 { status: "queued" | "running" }

Frontend polls manifest/status every 2–5 seconds
  -> when ready, load heavy tabs
```

In the current simple Hono/Python architecture, the least invasive version is:
- Hono adds endpoints that proxy to Python FastF1 backend.
- Python backend supports `/manifest/:year/:round`, `/prepare/:year/:round`, and granular JSON endpoints.
- Python does background preparation in a worker thread/process and writes JSON files.
- Hono keeps existing Jolpica endpoints as fallback.

---

## 5. Backend API Spec

### 5.1 Hono Public API

Keep existing endpoints where possible, but split heavy data:

#### `GET /api/f1/season/:year`

Purpose: fast season/race cards.

Response target: `< 1s`.

Data source priority:
1. Redis cached season summary.
2. Jolpica schedule/results/driver standings.
3. FastF1 schedule if Jolpica fails.

Response shape:

```json
{
  "year": 2026,
  "source": "jolpica+fastf1-cache",
  "races": [
    {
      "round": 1,
      "name": "Australian Grand Prix",
      "circuit": "Albert Park",
      "country": "Australia",
      "date": "2026-03-08",
      "flag": "🇦🇺",
      "status": "finished",
      "winner": "Driver Name",
      "winner_team": "Team",
      "winner_color": "#FF8000",
      "podium": ["AAA", "BBB", "CCC"],
      "fastf1_manifest_status": "ready"
    }
  ],
  "driver_standings": []
}
```

#### `GET /api/f1/race/:year/:round`

Purpose: backward-compatible race detail endpoint.

Implementation recommendation:
- Return summary + basic tabs from cached FastF1 if ready.
- Else return current Jolpica fallback plus `fastf1_status` so UI can show enrichment is preparing.

Add fields:

```json
{
  "fastf1_status": "missing|queued|running|ready|failed",
  "fastf1_ready": false,
  "detail_endpoints": {
    "manifest": "/api/f1/race/2026/1/manifest",
    "laps": "/api/f1/race/2026/1/laps",
    "telemetryIndex": "/api/f1/race/2026/1/telemetry-index"
  }
}
```

#### `GET /api/f1/race/:year/:round/manifest`

Returns status of materialized FastF1 cache.

```json
{
  "status": "missing|queued|running|ready|failed",
  "progress": 0.65,
  "message": "Generating telemetry files",
  "generated_at": null,
  "available": {}
}
```

#### `POST /api/f1/race/:year/:round/prepare`

Starts FastF1 background cache generation.

Response:

```json
{ "status": "queued", "message": "FastF1 preparation started" }
```

Safety:
- Idempotent. If running, return `running`; do not start duplicate work.
- Rate-limit by race key.

#### `GET /api/f1/race/:year/:round/laps`

Returns processed lap records optimized for charts.

```json
{
  "drivers": [{ "abbr": "VER", "number": "1", "name": "Max Verstappen", "team": "Red Bull", "color": "#3671C6" }],
  "max_lap": 58,
  "laps": [
    {
      "driver": "VER",
      "driver_number": "1",
      "lap": 1,
      "position": 1,
      "lap_time_ms": 93567,
      "lap_time": "1:33.567",
      "sector1_ms": 30123,
      "sector2_ms": 31234,
      "sector3_ms": 32210,
      "compound": "MEDIUM",
      "tyre_life": 4,
      "stint": 1,
      "fresh_tyre": true,
      "pit_in": false,
      "pit_out": false,
      "is_personal_best": false,
      "deleted": false,
      "track_status": "1"
    }
  ]
}
```

#### `GET /api/f1/race/:year/:round/strategy`

Real stints from FastF1:

```json
{
  "strategy": [
    {
      "driver": "Max Verstappen",
      "abbreviation": "VER",
      "team": "Red Bull",
      "color": "#3671C6",
      "stints": [
        {
          "stint": 1,
          "compound": "MEDIUM",
          "start_lap": 1,
          "end_lap": 18,
          "laps": 18,
          "tyre_age_start": 0,
          "tyre_age_end": 17,
          "fresh_tyre": true,
          "pit_in_lap": 18,
          "pit_out_lap": 19
        }
      ]
    }
  ]
}
```

#### `GET /api/f1/race/:year/:round/telemetry-index`

Lists available telemetry files and presets.

```json
{
  "drivers": ["VER", "NOR", "LEC"],
  "laps_by_driver": { "VER": [1, 2, 3, 4, 5] },
  "presets": {
    "fastest_laps": [{ "driver": "VER", "lap": 44, "lap_time": "1:31.234" }],
    "podium_fastest": [{ "driver": "VER", "lap": 44 }]
  }
}
```

#### `GET /api/f1/race/:year/:round/telemetry?driver=VER&lap=44`

Returns one driver/lap telemetry. Keep it small enough for browser.

```json
{
  "driver": "VER",
  "lap": 44,
  "lap_time_ms": 91234,
  "samples": [
    {
      "t_ms": 0,
      "distance": 0.0,
      "speed": 112,
      "rpm": 10420,
      "gear": 3,
      "throttle": 72,
      "brake": false,
      "drs": 0,
      "x": 1234.1,
      "y": -654.2
    }
  ]
}
```

Sampling guidance:
- Use distance-based simplification or `iloc[::3]`/`iloc[::5]`, but preserve enough fidelity for playback.
- Include `distance` whenever possible. Distance makes overlay comparisons far easier than raw sample index.
- Target 300–900 samples per lap, not thousands.

#### `GET /api/f1/race/:year/:round/track-map`

```json
{
  "rotation": 123.4,
  "points": [{ "x": 1, "y": 2, "distance": 0, "speed": 120, "gear": 3 }],
  "corners": [{ "number": 1, "letter": "", "x": 100, "y": 200, "angle": 45 }],
  "marshal_lights": [],
  "marshal_sectors": []
}
```

#### `GET /api/f1/race/:year/:round/weather`

```json
{
  "weather": [
    {
      "t_ms": 0,
      "session_time": "0 days 00:01:00",
      "air_temp": 27.2,
      "track_temp": 38.1,
      "humidity": 51.0,
      "pressure": 1012.1,
      "wind_speed": 2.4,
      "wind_direction": 180,
      "rainfall": false
    }
  ]
}
```

#### `GET /api/f1/race/:year/:round/race-control`

```json
{
  "messages": [
    {
      "t_ms": 123456,
      "lap_estimate": 14,
      "category": "Flag",
      "flag": "YELLOW",
      "scope": "Sector",
      "message": "YELLOW IN TRACK SECTOR 7"
    }
  ]
}
```

---

## 6. FastF1 Python Backend Spec

Current file: `f1_server.py`.

Recommended changes for implementation AI:

### 6.1 Keep FastF1 Backend Separate

Do not move FastF1 into Node. Keep Python service for FastF1 because FastF1 is a Python library and depends heavily on Pandas.

### 6.2 Add Persistent Processed Cache

Add helpers:

```python
CACHE_ROOT = os.environ.get('F1_PROCESSED_CACHE', './data/f1-cache')
FASTF1_CACHE = os.environ.get('FASTF1_CACHE', '/tmp/fastf1_cache')
```

Use atomic writes:
- Write to `file.tmp` first.
- Rename to final path after JSON dump completes.
- This prevents the frontend reading partial JSON.

### 6.3 Background Preparation State

Maintain in-memory status plus manifest file:

```python
_jobs = {
  '2026:1:R': {
    'status': 'running',
    'progress': 0.4,
    'message': 'Extracting lap data'
  }
}
```

Preparation stages:
1. `queued`
2. `loading_session` — `fastf1.get_event(year, round).get_race()` + `session.load(...)`
3. `extracting_results`
4. `extracting_laps`
5. `extracting_strategy`
6. `extracting_weather`
7. `extracting_race_control`
8. `extracting_track_map`
9. `extracting_telemetry_index`
10. `extracting_telemetry_files`
11. `ready` or `failed`

### 6.4 Load Modes

To avoid huge first-load latency, support two load modes:

#### `summary` mode

```python
session.load(laps=True, telemetry=False, weather=True, messages=True)
```

Use for:
- results
- laps
- strategy
- weather
- race control

#### `telemetry` mode

```python
session.load(laps=True, telemetry=True, weather=True, messages=True)
```

Use when creating telemetry and track-map files. If summary is ready before telemetry, write manifest as `partial`/`summary_ready` so tabs can load progressively.

Recommended statuses:
- `summary_ready` — results/laps/strategy/weather/race control available.
- `ready` — telemetry and track map available too.

### 6.5 Data Extraction Rules

#### Results

From `session.results`. Use both abbreviation and driver number. Driver number is important for `session.car_data`/`pos_data`.

Fields:
- Position, ClassifiedPosition, GridPosition, Q1/Q2/Q3 if present
- DriverNumber, BroadcastName, Abbreviation, FullName
- TeamName, TeamColor
- Time, Status, Points

#### Laps

From `session.laps`. Convert Pandas `Timedelta` to:
- display string (`1:32.123`)
- milliseconds (`92321`) for chart scales/sorting

Do not stringify everything only. Numeric fields must be numeric in JSON.

Important: include all valid race drivers, not just top 10. Frontend can filter.

#### Strategy

Group by `Driver` and `Stint`.

Use real fields:
- `Compound`
- `TyreLife`
- `FreshTyre`
- min/max `LapNumber`
- pit markers from `PitInTime`/`PitOutTime`

Do **not** guess compounds based on lap number. The current Hono Jolpica fallback does this and it is not acceptable for FastF1-enriched data.

#### Position Chart

Use `session.laps.Position` for lap-by-lap race position.

Fallback if `Position` missing:
- Use Jolpica lap positions.
- Mark `position_source: "jolpica"`.

#### Telemetry

Generate telemetry files only for useful laps initially:
- each driver's fastest valid lap
- podium fastest laps
- winner lap 1 and fastest lap
- selected “race event” laps around safety cars/pit windows if feasible

Optional later: lazily generate any requested driver/lap on-demand.

For each telemetry file:
- Merge car data and position data by time if possible.
- Add distance using FastF1 telemetry helpers if available (`add_distance()` on telemetry object in common FastF1 workflows).
- Downsample to target size.
- Include x/y for track map synchronization.

#### Track Map

Recommended easiest initial implementation:
- Use fastest lap position data from the race winner or overall fastest lap.
- Normalize/rotate only if necessary for display; frontend can scale to canvas/SVG.
- Include corner annotations from `session.get_circuit_info()` if available.

---

## 7. Frontend Interaction Spec

The current frontend uses inline JS in `src/pages/index.astro` and `<canvas>`. The implementer can keep this style, but the UI will be much easier with a small chart helper layer.

### 7.1 Minimum No-Dependency Version

If avoiding new dependencies:
- Use `<canvas>` for lap chart, telemetry traces, track map.
- Add mouse handling manually:
  - `mousemove` maps x coordinate to lap/sample.
  - Draw hover vertical line and tooltip.
  - `click` pins selected driver/lap.
  - `requestAnimationFrame` handles playback.

### 7.2 Better Recommended Version

Add one visualization library:
- **Plotly.js** for telemetry/lap-time charts because zoom/pan/hover/legend are built in.
- Keep custom canvas/SVG for track replay.

Alternative:
- **D3.js** gives maximum control but more implementation work.

Recommended package:
```bash
npm install plotly.js-dist-min
```

If bundle size matters, lazy-load Plotly only when F1 modal opens:
```js
const Plotly = await import('plotly.js-dist-min');
```

### 7.3 Race Replay Controls

Add controls above Race Replay tab:

```text
[▶ Play] [⏸ Pause] [⟲ Reset]  Lap [ 1 ━━━━━●━━━━ 58 ]  Speed [0.5x 1x 2x]
Search driver: [ VER        ]  Filters: [Top 10] [All] [Team]
```

State object:

```js
const replayState = {
  playing: false,
  currentLap: 1,
  maxLap: 58,
  speed: 1,
  selectedDrivers: new Set(),
  hoveredDriver: null,
  pinnedDriver: null,
  mode: 'top10'
};
```

Behavior:
- Play increments lap every ~600ms at 1x.
- Canvas/chart highlights current lap vertical line.
- Leaderboard table updates to positions at current lap.
- Clicking a driver in legend toggles highlight.
- Search filters/highlights matching abbreviation/name.

### 7.4 Synchronized Telemetry + Track Map

State:

```js
const telemetryState = {
  driverA: 'VER',
  lapA: 44,
  driverB: 'NOR',
  lapB: 44,
  channelVisibility: { speed: true, throttle: true, brake: true, gear: true, rpm: false, drs: true },
  cursorIndex: 0,
  playing: false
};
```

Behavior:
- Hover any telemetry chart -> update cursor index -> move dot on track map.
- Scrubber/playback moves cursor index -> charts draw vertical cursor -> track dot moves.
- In compare mode, map two dots; show delta card:
  - `+0.132s at 2310m`
  - “A gains on straight”, “B brakes later” is optional and can be later.

### 7.5 UI Styling Direction

The current app already uses a dark neon sports dashboard style. Extend it:
- Use F1 red `#e10600` as the F1 accent, but keep team colors on driver data.
- Use glassy cards with subtle borders; avoid giant white chart backgrounds.
- Use tab badges: `Ready`, `Preparing`, `No data`.
- Use skeleton loaders rather than a dead spinner for FastF1.
- Show source badges:
  - `Jolpica fallback`
  - `FastF1 summary ready`
  - `FastF1 telemetry ready`

### 7.6 Empty/Error States

Must handle:
- Future race: “Race has not happened yet.”
- FastF1 currently preparing: progress bar + “You can keep viewing results.”
- FastF1 failed: show Jolpica fallback and error details hidden in `<details>`.
- No telemetry for a driver/lap: disable option or show “Telemetry unavailable for this lap.”
- Large mobile screen constraints: charts horizontally scroll or switch to compact view.

---

## 8. Specific Fix for Blank Lap Chart

Likely causes:
1. Driver identifiers mismatch between `data.results[].abbreviation` and `data.laps[].driver`.
2. Canvas draws only y positions 1–10, but selected drivers may have positions outside 10 or positions missing.
3. Chart is drawn while tab is hidden or canvas has CSS/layout issues.
4. Jolpica `/laps.json?limit=2000` may not include all laps for full race if 20 drivers × 50–70 laps exceeds 2000; raise limit or paginate.

Implementation requirements:
- Normalize driver keys once in backend. Use FastF1 abbreviation as canonical (`VER`, `NOR`).
- Include `drivers` list in lap response and draw from it, not only from results.
- Compute y domain dynamically: `1..maxPosition`, not hard-coded `1..10` unless filter is top10.
- Ensure each driver’s lap rows are sorted by lap before drawing.
- Draw disconnected segments if positions are missing instead of connecting bad data.
- If using Jolpica fallback, fetch enough laps:
  - full race can be ~20 × 70 = 1400 rows, but 2000 is okay for most; still use pagination/limit high enough (`limit=3000`) if Jolpica supports.
- Add a visible empty state if `laps.length === 0` or if no plotted points match selected drivers.

---

## 9. Implementation Plan for Another AI

### Phase 0 — Safety and Baseline

1. Verify `.env` is gitignored and no secrets are tracked.
2. Do not touch World Cup endpoints except shared server plumbing.
3. Run current app locally and capture current `/api/f1/season/2026` and `/api/f1/race/2026/1` response shapes before changing.
4. Keep backward compatibility for existing frontend until the new endpoints are wired.

### Phase 1 — Python FastF1 Cache Service

1. Add persistent processed cache directory support to `f1_server.py`.
2. Add manifest/status endpoint.
3. Add background prepare endpoint.
4. Implement summary extraction with `telemetry=False` first.
5. Write `summary.json`, `results.json`, `laps.json`, `strategy.json`, `weather.json`, `race_control.json`.
6. Implement telemetry extraction separately and write `telemetry_index.json`, `telemetry/*.json`, `track_map.json`.
7. Add defensive exception handling per extraction section so one failed dataset does not fail all.
8. Add CORS headers and JSON error shapes consistently.

### Phase 2 — Hono Proxy and Fallback

1. In `server.mjs`, add helpers to call `F1_BACKEND` with timeout.
2. Add new public `/api/f1/race/:year/:round/...` endpoints.
3. Keep old `/api/f1/race/:year/:round` but enrich it with FastF1 manifest/status fields.
4. If Python backend is down, return Jolpica fallback and `fastf1_status: "offline"`.
5. Cache small manifest/summary responses in Redis, but do not cache `running` forever.

### Phase 3 — Frontend Race Modal Progressive Loading

1. Open modal with current fast summary immediately.
2. Fetch manifest.
3. If not ready, show preparation panel and call prepare.
4. Poll until summary/ready.
5. Load heavy tabs lazily only when tab is clicked.
6. Do not load every telemetry file on modal open.

### Phase 4 — Fix and Upgrade Lap Chart

1. Replace static lap chart with interactive replay state.
2. Dynamic y-axis domain and driver-key normalization.
3. Add current lap scrubber + play/pause.
4. Add hover tooltip and driver highlight.
5. Add lap leaderboard table synced to current lap.
6. Add empty states and source badges.

### Phase 5 — Strategy + Lap Times

1. Use FastF1 real strategy when available.
2. Add lap time scatter/line chart with compound colors.
3. Add filters for pit laps, deleted laps, safety-car laps, selected drivers.
4. Tooltips include sector times, compound, tyre life, track status.

### Phase 6 — Telemetry Compare + Track Map

1. Add telemetry selector UI.
2. Fetch only selected telemetry files.
3. Draw multi-channel telemetry traces.
4. Add synchronized cursor.
5. Add track map and playback dot.
6. Add compare mode with two drivers/laps.

### Phase 7 — Validation and Deployment

1. Test a finished race with known FastF1 data.
2. Test a future race.
3. Test Python backend offline.
4. Test first-load cache generation and post-cache fast load.
5. Test mobile modal layout.
6. Build Astro and restart deployed services.

---

## 10. Acceptance Criteria

### Data

- FastF1 enriched race detail includes real results, real lap times, real compounds/stints, weather, race control, and at least selected telemetry.
- Jolpica remains available as fallback for fast season cards and when FastF1 fails.
- No guessed compounds in FastF1 strategy.
- Lap chart data uses consistent driver identifiers.

### Performance

- Season view loads in under 1s from cache/fallback.
- Race modal shows basic content in under 1s even if FastF1 is not ready.
- First FastF1 preparation can run asynchronously without freezing the UI.
- Once prepared, detailed tabs load in under 2s.
- Telemetry endpoint returns only requested driver/lap, not every driver/lap at once.

### UX

- Lap chart is visible and interactive.
- User can play/pause/scrub race progression.
- User can search/filter/highlight drivers.
- Telemetry compare supports at least two drivers/laps.
- Track map has synchronized cursor/playback dot.
- Clear loading/error/source states exist.

### Reliability

- Python FastF1 crashes/failures do not break the Hono server or WC dashboard.
- Cache writes are atomic.
- Duplicate prepare requests do not spawn duplicate jobs.
- No secrets are committed.

---

## 11. Suggested Libraries

Minimal:
- Existing Astro/Hono/vanilla JS.
- Canvas for charts.

Recommended:
- `plotly.js-dist-min` for lap times and telemetry traces.
- Custom canvas/SVG for replay track map.

Avoid unless doing a larger refactor:
- Full React/Next migration. The app is currently Astro with inline JS; a full framework migration is unnecessary for this task.

---

## 12. References and Inspiration

FastF1 official docs:
- `https://docs.fastf1.dev/` — FastF1 overview and docs.
- `https://docs.fastf1.dev/core.html` — Session/Laps/Lap/Telemetry objects.
- `https://docs.fastf1.dev/fastf1.html` — event/session/cache functions.
- `https://docs.fastf1.dev/gen_modules/examples_gallery/index.html` — example gallery.

Useful inspiration from public dashboards/search results:
- GP Tempo — web telemetry exploration listed by FastF1 docs.
- Armchair Strategist — race strategy dashboard listed by FastF1 docs.
- F1 dashboards commonly include: lap-time scatter, tyre strategy bars, race position trace, gap-to-leader chart, speed/throttle/brake/gear overlays, track-map replay, race-control timeline, weather charts.

---

## 13. Do Not Do

- Do not block `/api/f1/race/:year/:round` for 60 seconds waiting on full telemetry.
- Do not fetch all telemetry for all drivers/laps on modal open.
- Do not keep guessed compounds once FastF1 data is available.
- Do not silently show a blank canvas; always show empty/error state.
- Do not break current World Cup match modals/tabs.
- Do not commit `.env`, Redis tokens, DB URLs, API keys, or generated files containing secrets.
