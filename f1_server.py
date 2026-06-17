#!/usr/bin/env python3
"""FastF1 telemetry backend — persistent cache + background prepare + granular endpoints."""
import json
import os
import sys
import time
import threading
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

os.environ['FASTF1_CACHE'] = '/tmp/fastf1_cache'
os.makedirs('/tmp/fastf1_cache', exist_ok=True)

import fastf1
import pandas as pd
import numpy as np

PORT = int(os.environ.get('F1_PORT', 4000))
CACHE_ROOT = os.environ.get('F1_PROCESSED_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'f1-cache'))
os.makedirs(CACHE_ROOT, exist_ok=True)

# ---------------------------------------------------------------------------
# Job tracking
# ---------------------------------------------------------------------------
_jobs = {}       # key: "year:round" -> { status, progress, message, started_at }
_jobs_lock = threading.Lock()

# In-memory cache for quick lookups
_cache = {}
_cache_lock = threading.Lock()

def cache_get(key):
    with _cache_lock:
        return _cache.get(key)

def cache_set(key, val):
    with _cache_lock:
        _cache[key] = val

# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def race_dir(year, rnd):
    return os.path.join(CACHE_ROOT, str(year), str(rnd))

def read_json(path):
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return None

def write_json_atomic(path, data):
    """Write JSON atomically: tmp + rename."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, default=_json_default)
    os.replace(tmp, path)

def _json_default(obj):
    """Handle Pandas/numpy types in JSON serialization."""
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    if isinstance(obj, pd.Timedelta):
        return td_to_ms(obj)
    if isinstance(obj, pd.NaT.__class__):
        return None
    return str(obj)

def td_to_ms(td):
    """Convert a Timedelta to milliseconds (int). Returns None for NaT/None."""
    if td is None or pd.isna(td):
        return None
    try:
        return int(td.total_seconds() * 1000)
    except Exception:
        return None

def td_to_str(td):
    """Convert a Timedelta to human-readable string like '1:32.123'."""
    if td is None or pd.isna(td):
        return None
    try:
        total = td.total_seconds()
        mins = int(total // 60)
        secs = total % 60
        return f"{mins}:{secs:06.3f}"
    except Exception:
        return str(td)

def safe_val(v, default=None):
    """Return default if v is NaN/NaT/None."""
    if v is None:
        return default
    try:
        if pd.isna(v):
            return default
    except Exception:
        pass
    return v

def safe_int(v, default=0):
    sv = safe_val(v, None)
    if sv is None:
        return default
    try:
        return int(sv)
    except Exception:
        return default

def safe_float(v, default=0.0):
    sv = safe_val(v, None)
    if sv is None:
        return default
    try:
        return float(sv)
    except Exception:
        return default

def safe_str(v, default=''):
    sv = safe_val(v, None)
    if sv is None:
        return default
    return str(sv)

def compound_color(compound):
    return {
        'SOFT': '#ff3333', 'MEDIUM': '#ffcc00', 'HARD': '#eeeeee',
        'INTERMEDIATE': '#00cc66', 'WET': '#0066ff'
    }.get(compound, '#888888')

def job_key(year, rnd):
    return f"{year}:{rnd}"

def get_job(year, rnd):
    with _jobs_lock:
        return _jobs.get(job_key(year, rnd))

def set_job(year, rnd, status, progress=0, message=''):
    with _jobs_lock:
        _jobs[job_key(year, rnd)] = {
            'status': status,
            'progress': progress,
            'message': message,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }

# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------

def read_manifest(year, rnd):
    path = os.path.join(race_dir(year, rnd), 'manifest.json')
    return read_json(path)

def write_manifest(year, rnd, manifest):
    path = os.path.join(race_dir(year, rnd), 'manifest.json')
    write_json_atomic(path, manifest)

# ---------------------------------------------------------------------------
# Data extraction from FastF1 session
# ---------------------------------------------------------------------------

def extract_results(session):
    """Extract race results as list of dicts."""
    results = []
    if session.results is None:
        return results
    for _, r in session.results.iterrows():
        results.append({
            'position': safe_int(r.get('Position'), 0),
            'classified_position': safe_str(r.get('ClassifiedPosition'), ''),
            'grid_position': safe_int(r.get('GridPosition'), 0),
            'driver_number': safe_str(r.get('DriverNumber'), ''),
            'abbreviation': safe_str(r.get('Abbreviation'), ''),
            'broadcast_name': safe_str(r.get('BroadcastName'), ''),
            'full_name': safe_str(r.get('FullName'), ''),
            'first_name': safe_str(r.get('FirstName'), ''),
            'last_name': safe_str(r.get('LastName'), ''),
            'team_name': safe_str(r.get('TeamName'), ''),
            'team_color': f"#{safe_str(r.get('TeamColor'), 'ffffff')}",
            'time_ms': td_to_ms(r.get('Time')),
            'time': td_to_str(r.get('Time')),
            'status': safe_str(r.get('Status'), ''),
            'points': safe_float(r.get('Points'), 0),
            'laps': safe_int(r.get('Laps'), 0),
        })
    return results

def extract_drivers(session, results):
    """Build driver lookup from results."""
    drivers = []
    for r in results:
        drivers.append({
            'abbr': r['abbreviation'],
            'number': r['driver_number'],
            'name': r['full_name'] or f"{r['first_name']} {r['last_name']}".strip(),
            'team': r['team_name'],
            'color': r['team_color'],
        })
    return drivers

def extract_laps(session, results):
    """Extract lap data for position chart + lap times."""
    laps = []
    if session.laps is None:
        return laps

    # Build pit lap sets per driver
    pit_in_set = set()
    pit_out_set = set()
    for _, lap in session.laps.iterrows():
        d = safe_str(lap.get('Driver'), '')
        ln = safe_int(lap.get('LapNumber'), 0)
        if lap.get('PitOutTime') is not None and not pd.isna(lap.get('PitOutTime')):
            pit_out_set.add((d, ln))
        if lap.get('PitInTime') is not None and not pd.isna(lap.get('PitInTime')):
            pit_in_set.add((d, ln))

    for _, lap in session.laps.iterrows():
        d = safe_str(lap.get('Driver'), '')
        ln = safe_int(lap.get('LapNumber'), 0)
        lt = lap.get('LapTime')
        s1 = lap.get('Sector1Time')
        s2 = lap.get('Sector2Time')
        s3 = lap.get('Sector3Time')

        laps.append({
            'driver': d,
            'driver_number': safe_str(lap.get('DriverNumber'), ''),
            'lap': ln,
            'position': safe_int(lap.get('Position'), 0),
            'lap_time_ms': td_to_ms(lt),
            'lap_time': td_to_str(lt),
            'sector1_ms': td_to_ms(s1),
            'sector2_ms': td_to_ms(s2),
            'sector3_ms': td_to_ms(s3),
            'sector1': td_to_str(s1),
            'sector2': td_to_str(s2),
            'sector3': td_to_str(s3),
            'compound': safe_str(lap.get('Compound'), ''),
            'tyre_life': safe_int(lap.get('TyreLife'), 0),
            'stint': safe_int(lap.get('Stint'), 0),
            'fresh_tyre': bool(safe_val(lap.get('FreshTyre'), False)),
            'pit_in': (d, ln) in pit_in_set,
            'pit_out': (d, ln) in pit_out_set,
            'is_personal_best': bool(safe_val(lap.get('IsPersonalBest'), False)),
            'deleted': bool(safe_val(lap.get('Deleted'), False)),
            'track_status': safe_str(lap.get('TrackStatus'), ''),
            'speed_fl': safe_float(lap.get('SpeedFL'), 0),
            'speed_i1': safe_float(lap.get('SpeedI1'), 0),
            'speed_i2': safe_float(lap.get('SpeedI2'), 0),
            'speed_st': safe_float(lap.get('SpeedST'), 0),
        })
    return laps

def extract_strategy(session):
    """Extract real stint data grouped by driver + stint."""
    strategy = []
    if session.laps is None:
        return strategy

    drivers = session.laps['Driver'].unique()
    for driver in drivers:
        driver_laps = session.laps[session.laps['Driver'] == driver]
        stints = []
        stint_groups = driver_laps.groupby('Stint')
        for stint_num, stint_data in sorted(stint_groups, key=lambda x: safe_int(x[0], 999)):
            if len(stint_data) == 0:
                continue
            stints.append({
                'stint': safe_int(stint_num, 0),
                'compound': safe_str(stint_data['Compound'].iloc[0], ''),
                'start_lap': safe_int(stint_data['LapNumber'].min(), 0),
                'end_lap': safe_int(stint_data['LapNumber'].max(), 0),
                'laps': len(stint_data),
                'tyre_age_start': safe_int(stint_data['TyreLife'].min(), 0),
                'tyre_age_end': safe_int(stint_data['TyreLife'].max(), 0),
                'fresh_tyre': bool(safe_val(stint_data['FreshTyre'].iloc[0], False)),
            })

        # Try to get pit in/out laps from the data
        pit_laps = []
        for _, lap in driver_laps.iterrows():
            if lap.get('PitInTime') is not None and not pd.isna(lap.get('PitInTime')):
                pit_laps.append(safe_int(lap.get('LapNumber'), 0))

        for i, s in enumerate(stints):
            if i < len(pit_laps):
                s['pit_in_lap'] = pit_laps[i]
            if i + 1 < len(stints):
                s['pit_out_lap'] = stints[i + 1]['start_lap']

        strategy.append({
            'driver': safe_str(driver, ''),
            'abbreviation': safe_str(driver, ''),
            'stints': stints,
        })

    # Enrich with results info
    return strategy

def enrich_strategy_with_results(strategy, results):
    """Add name/team/color from results to strategy entries."""
    result_map = {r['abbreviation']: r for r in results}
    for s in strategy:
        r = result_map.get(s['abbreviation'], {})
        s['driver'] = r.get('full_name', s.get('driver', ''))
        s['team'] = r.get('team_name', '')
        s['color'] = r.get('team_color', '#ffffff')
    return strategy

def extract_weather(session):
    """Extract weather data."""
    weather = []
    if session.weather_data is None:
        return weather
    for _, w in session.weather_data.iterrows():
        weather.append({
            't_ms': td_to_ms(w.get('Time')),
            'air_temp': safe_float(w.get('AirTemp'), 0),
            'track_temp': safe_float(w.get('TrackTemp'), 0),
            'humidity': safe_float(w.get('Humidity'), 0),
            'pressure': safe_float(w.get('Pressure'), 0),
            'wind_speed': safe_float(w.get('WindSpeed'), 0),
            'wind_direction': safe_float(w.get('WindDirection'), 0),
            'rainfall': bool(safe_val(w.get('Rainfall'), False)),
        })
    return weather

def extract_race_control(session):
    """Extract race control messages."""
    messages = []
    if session.race_control_messages is None:
        return messages
    for _, msg in session.race_control_messages.iterrows():
        messages.append({
            't_ms': td_to_ms(msg.get('Time')),
            'category': safe_str(msg.get('Category'), ''),
            'flag': safe_str(msg.get('Flag'), ''),
            'scope': safe_str(msg.get('Scope'), ''),
            'message': safe_str(msg.get('Message'), ''),
            'lap': safe_int(msg.get('LapNumber'), 0),
            'sector': safe_int(msg.get('Sector'), 0),
        })
    return messages

def extract_track_map(session):
    """Extract track outline from fastest lap position data."""
    try:
        fastest = session.laps.pick_fastest()
        if fastest is None:
            return None
        pos = fastest.get_pos_data()
        if pos is None or len(pos) == 0:
            return None

        # Get x,y positions
        points = []
        step = max(1, len(pos) // 500)
        for i in range(0, len(pos), step):
            row = pos.iloc[i]
            p = {
                'x': safe_float(row.get('X'), 0),
                'y': safe_float(row.get('Y'), 0),
            }
            # Include speed if available from car data
            points.append(p)

        result = {
            'points': points,
            'rotation': 0,
            'corners': [],
        }

        # Try to get circuit info for corner annotations
        try:
            cinfo = session.get_circuit_info()
            if cinfo is not None and cinfo.corners is not None:
                corners = []
                for _, c in cinfo.corners.iterrows():
                    corners.append({
                        'number': safe_int(c.get('Number'), 0),
                        'letter': safe_str(c.get('Letter'), ''),
                        'x': safe_float(c.get('X'), 0),
                        'y': safe_float(c.get('Y'), 0),
                        'angle': safe_float(c.get('Angle'), 0),
                    })
                result['corners'] = corners
                if hasattr(cinfo, 'rotation'):
                    result['rotation'] = safe_float(cinfo.rotation, 0)
        except Exception:
            pass

        return result
    except Exception:
        return None

def extract_telemetry_for_lap(session, driver_abbr, lap_number):
    """Extract telemetry for a specific driver and lap."""
    try:
        driver_laps = session.laps.pick_drivers(driver_abbr)
        if driver_laps is None or len(driver_laps) == 0:
            return None

        target_lap = driver_laps[driver_laps['LapNumber'] == lap_number]
        if len(target_lap) == 0:
            return None

        lap = target_lap.iloc[0]
        car_data = lap.get_car_data()
        pos_data = lap.get_pos_data()

        if car_data is None or len(car_data) == 0:
            return None

        # Merge car + pos data by nearest time
        samples = []
        step = max(1, len(car_data) // 600)  # target ~600 samples

        for i in range(0, len(car_data), step):
            row = car_data.iloc[i]
            sample = {
                't_ms': td_to_ms(row.get('Time')),
                'speed': safe_float(row.get('Speed'), 0),
                'rpm': safe_int(row.get('RPM'), 0),
                'gear': safe_int(row.get('nGear'), 0),
                'throttle': safe_float(row.get('Throttle'), 0),
                'brake': bool(safe_val(row.get('Brake'), False)),
                'drs': safe_int(row.get('DRS'), 0),
            }

            # Add position data (x,y) if available
            if pos_data is not None and len(pos_data) > 0:
                t = row.get('Time')
                if t is not None and not pd.isna(t):
                    idx = (pos_data['Time'] - t).abs().idxmin()
                    pr = pos_data.loc[idx]
                    sample['x'] = safe_float(pr.get('X'), 0)
                    sample['y'] = safe_float(pr.get('Y'), 0)

            samples.append(sample)

        return {
            'driver': driver_abbr,
            'lap': lap_number,
            'lap_time_ms': td_to_ms(lap.get('LapTime')),
            'lap_time': td_to_str(lap.get('LapTime')),
            'compound': safe_str(lap.get('Compound'), ''),
            'tyre_life': safe_int(lap.get('TyreLife'), 0),
            'samples': samples,
        }
    except Exception as e:
        return None

def extract_telemetry_index(session, results):
    """Build telemetry index: available driver/lap combos and presets."""
    laps_by_driver = {}
    fastest_laps = []

    if session.laps is not None:
        drivers = session.laps['Driver'].unique()
        for d in drivers:
            dl = session.laps[session.laps['Driver'] == d]
            # Filter out laps with no valid time
            valid = dl[dl['LapTime'].notna()]
            laps_by_driver[d] = sorted(valid['LapNumber'].astype(int).tolist())

            try:
                fl = dl.pick_fastest()
                if fl is not None and fl.get('LapTime') is not None:
                    fastest_laps.append({
                        'driver': d,
                        'lap': safe_int(fl.get('LapNumber'), 0),
                        'lap_time': td_to_str(fl.get('LapTime')),
                    })
            except Exception:
                pass

    # Presets: podium fastest
    podium_fastest = []
    for r in results[:3]:
        abbr = r.get('abbreviation', '')
        if abbr:
            match = [f for f in fastest_laps if f['driver'] == abbr]
            if match:
                podium_fastest.append(match[0])

    return {
        'drivers': list(laps_by_driver.keys()),
        'laps_by_driver': laps_by_driver,
        'presets': {
            'fastest_laps': fastest_laps,
            'podium_fastest': podium_fastest,
        }
    }

def rebuild_telemetry_index_from_cache(rd, summary):
    results = read_json(os.path.join(rd, 'results.json')) or {}
    drivers = results.get('drivers', [])
    abbrev_to_name = {d['abbr']: d.get('name', d['abbr']) for d in drivers}

    tel_dir = os.path.join(rd, 'telemetry')
    entries = []
    if os.path.isdir(tel_dir):
        for fname in sorted(os.listdir(tel_dir)):
            if not fname.endswith('.json'):
                continue
            base = fname[:-5]
            if '_' not in base:
                continue
            abbr, lap_str = base.rsplit('_', 1)
            try:
                lap = int(lap_str)
            except Exception:
                continue
            entry = read_json(os.path.join(tel_dir, fname))
            entries.append({
                'driver': abbr,
                'lap': lap,
                'lap_time': (entry or {}).get('lap_time'),
                'lap_time_ms': (entry or {}).get('lap_time_ms'),
                'compound': (entry or {}).get('compound'),
                'available': True,
            })

    laps_by_driver = {}
    for e in entries:
        laps_by_driver.setdefault(e['driver'], []).append(e['lap'])
    for k in laps_by_driver:
        laps_by_driver[k] = sorted(set(laps_by_driver[k]))

    fastest_laps = []
    seen = set()
    for e in entries:
        key = (e['driver'], e['lap'])
        if key in seen:
            continue
        seen.add(key)
        fastest_laps.append({
            'driver': e['driver'],
            'lap': e['lap'],
            'lap_time': e['lap_time'],
            'lap_time_ms': e['lap_time_ms'],
            'compound': e['compound'],
        })

    summary_fast = (summary or {}).get('fastest_lap')
    if summary_fast and summary_fast.get('abbreviation'):
        key = (summary_fast['abbreviation'], summary_fast.get('lap'))
        if key not in seen:
            fastest_laps.insert(0, {
                'driver': summary_fast['abbreviation'],
                'lap': summary_fast.get('lap'),
                'lap_time': summary_fast.get('lap_time'),
                'lap_time_ms': summary_fast.get('lap_time_ms'),
                'compound': summary_fast.get('compound'),
            })

    podium_fastest = []
    for r in (results.get('results') or [])[:3]:
        abbr = r.get('abbreviation')
        if not abbr:
            continue
        match = next((f for f in fastest_laps if f['driver'] == abbr), None)
        if match:
            podium_fastest.append(match)

    return {
        'drivers': sorted(laps_by_driver.keys()) if laps_by_driver else [],
        'laps_by_driver': laps_by_driver,
        'generated_files': len(entries),
        'presets': {
            'fastest_laps': fastest_laps,
            'podium_fastest': podium_fastest,
        },
    }

# ---------------------------------------------------------------------------
# Background preparation
# ---------------------------------------------------------------------------

def prepare_race(year, rnd):
    """Full background preparation of a race's FastF1 data."""
    key = job_key(year, rnd)
    rd = race_dir(year, rnd)

    try:
        # Phase 1: Load session (summary mode first for speed)
        set_job(year, rnd, 'loading_session', 0.05, 'Loading FastF1 session...')
        event = fastf1.get_event(int(year), int(rnd))
        session = event.get_race()

        # Try loading summary first (no telemetry = much faster)
        try:
            session.load(laps=True, telemetry=False, weather=True, messages=True)
        except Exception:
            # Some old sessions may need telemetry=True to load laps
            session.load(laps=True, telemetry=True, weather=True, messages=True)

        # Phase 2+: Extract available datasets without failing the full job
        warnings = []
        results = []
        drivers = []
        laps = []
        max_lap = 0
        strategy = []
        weather = []
        race_control = []
        fastest_lap_data = None
        summary = {
            'name': safe_str(getattr(session.event, 'EventName', None) if hasattr(session, 'event') else '', ''),
            'circuit': safe_str(getattr(session.event, 'CircuitShortName', None) if hasattr(session, 'event') else '', ''),
            'country': safe_str(getattr(session.event, 'Country', None) if hasattr(session, 'event') else '', ''),
            'location': safe_str(getattr(session.event, 'Location', None) if hasattr(session, 'event') else '', ''),
            'date': safe_str(getattr(session.event, 'EventDate', None) if hasattr(session, 'event') else '', ''),
            'total_laps': 0,
            'total_drivers': 0,
            'fastest_lap': None,
            'has_weather': False,
            'has_rain': False,
            'has_race_control': False,
            'safety_cars': 0,
            'vsc_count': 0,
        }
        manifest = {
            'year': int(year),
            'round': int(rnd),
            'session': 'R',
            'status': 'summary_ready',
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'fastf1_version': getattr(fastf1, '__version__', 'unknown'),
            'event_name': summary['name'],
            'cache_schema_version': 1,
            'available': {
                'results': False,
                'laps': False,
                'strategy': False,
                'weather': False,
                'race_control': False,
                'position_series': False,
                'track_map': False,
                'telemetry': False,
            },
            'warnings': warnings,
        }

        # Phase 2: Extract results
        try:
            set_job(year, rnd, 'extracting_results', 0.15, 'Extracting results...')
            results = extract_results(session)
            drivers = extract_drivers(session, results)
            write_json_atomic(os.path.join(rd, 'results.json'), {'drivers': drivers, 'results': results})
            manifest['available']['results'] = True
        except Exception as exc:
            warnings.append(f'results extraction failed: {exc}')

        # Phase 3: Extract laps
        try:
            set_job(year, rnd, 'extracting_laps', 0.25, 'Extracting lap data...')
            laps = extract_laps(session, results)
            max_lap = max((l['lap'] for l in laps), default=0) if laps else 0
            write_json_atomic(os.path.join(rd, 'laps.json'), {
                'drivers': drivers, 'max_lap': max_lap, 'laps': laps
            })
            manifest['available']['laps'] = bool(laps)
        except Exception as exc:
            warnings.append(f'laps extraction failed: {exc}')

        # Phase 4: Extract strategy
        try:
            set_job(year, rnd, 'extracting_strategy', 0.35, 'Extracting strategy...')
            strategy = extract_strategy(session)
            strategy = enrich_strategy_with_results(strategy, results)
            write_json_atomic(os.path.join(rd, 'strategy.json'), {'strategy': strategy})
            manifest['available']['strategy'] = bool(strategy)
        except Exception as exc:
            warnings.append(f'strategy extraction failed: {exc}')

        # Phase 5: Weather
        try:
            set_job(year, rnd, 'extracting_weather', 0.45, 'Extracting weather...')
            weather = extract_weather(session)
            write_json_atomic(os.path.join(rd, 'weather.json'), {'weather': weather})
            manifest['available']['weather'] = bool(weather)
        except Exception as exc:
            warnings.append(f'weather extraction failed: {exc}')

        # Phase 6: Race control
        try:
            set_job(year, rnd, 'extracting_race_control', 0.50, 'Extracting race control...')
            race_control = extract_race_control(session)
            write_json_atomic(os.path.join(rd, 'race_control.json'), {'messages': race_control})
            manifest['available']['race_control'] = bool(race_control)
        except Exception as exc:
            warnings.append(f'race control extraction failed: {exc}')

        # Write summary manifest
        try:
            total_laps = int(session.total_laps) if session.total_laps else max_lap
            try:
                fl = session.laps.pick_fastest()
                if fl is not None:
                    fl_driver = safe_str(fl.get('Driver'), '')
                    fl_info = next((r for r in results if r['abbreviation'] == fl_driver), {})
                    fastest_lap_data = {
                        'driver': fl_info.get('full_name', fl_driver),
                        'abbreviation': fl_driver,
                        'team': fl_info.get('team_name', ''),
                        'lap_time': td_to_str(fl.get('LapTime')),
                        'lap_time_ms': td_to_ms(fl.get('LapTime')),
                        'lap': safe_int(fl.get('LapNumber'), 0),
                        'compound': safe_str(fl.get('Compound'), ''),
                    }
            except Exception as fl_exc:
                warnings.append(f'fastest lap extraction failed: {fl_exc}')

            summary.update({
                'total_laps': total_laps,
                'total_drivers': len(results),
                'fastest_lap': fastest_lap_data,
                'has_weather': len(weather) > 0,
                'has_rain': any(w.get('rainfall') for w in weather),
                'has_race_control': len(race_control) > 0,
                'safety_cars': sum(1 for m in race_control if 'SAFETY CAR' in m.get('message', '').upper() and 'VIRTUAL' not in m.get('message', '').upper()),
                'vsc_count': sum(1 for m in race_control if 'VIRTUAL' in m.get('message', '').upper() and 'SAFETY' in m.get('message', '').upper()),
            })
            write_json_atomic(os.path.join(rd, 'summary.json'), summary)
        except Exception as exc:
            warnings.append(f'summary build failed: {exc}')

        manifest['generated_at'] = datetime.now(timezone.utc).isoformat()
        manifest['event_name'] = summary['name']
        write_manifest(year, rnd, manifest)

        # Phase 7: Try telemetry (may already be loaded)
        set_job(year, rnd, 'extracting_telemetry', 0.60, 'Extracting telemetry data...')

        # Check if telemetry was loaded
        has_telemetry = False
        try:
            # Test if car_data is available
            first_driver = session.drivers[0] if session.drivers else None
            if first_driver and first_driver in session.car_data:
                has_telemetry = len(session.car_data[first_driver]) > 0
        except Exception:
            pass

        if not has_telemetry:
            # Reload with telemetry
            set_job(year, rnd, 'loading_telemetry', 0.60, 'Reloading session with telemetry...')
            try:
                session.load(laps=True, telemetry=True, weather=True, messages=True)
                has_telemetry = True
            except Exception as e:
                manifest['warnings'].append(f'Telemetry load failed: {str(e)}')
                write_manifest(year, rnd, manifest)

        if has_telemetry:
            # Track map
            set_job(year, rnd, 'extracting_track_map', 0.70, 'Generating track map...')
            try:
                track_map = extract_track_map(session)
                if track_map:
                    write_json_atomic(os.path.join(rd, 'track_map.json'), track_map)
                    manifest['available']['track_map'] = True
                    manifest['available']['position_series'] = True
            except Exception:
                pass

            # Extract fastest lap telemetry for each driver, then rebuild telemetry index from cache
            set_job(year, rnd, 'extracting_telemetry_files', 0.85, 'Extracting telemetry files...')
            os.makedirs(os.path.join(rd, 'telemetry'), exist_ok=True)
            tel_count = 0

            session_fastest_laps = []
            try:
                if session.laps is not None:
                    for d in session.laps['Driver'].unique():
                        try:
                            dl = session.laps[session.laps['Driver'] == d]
                            fl = dl.pick_fastest()
                            if fl is not None and fl.get('LapTime') is not None:
                                session_fastest_laps.append({
                                    'driver': d,
                                    'lap': safe_int(fl.get('LapNumber'), 0),
                                })
                        except Exception:
                            continue
            except Exception:
                pass

            for entry in session_fastest_laps:
                d = entry['driver']
                lap_num = entry['lap']
                try:
                    tel = extract_telemetry_for_lap(session, d, lap_num)
                    if tel:
                        path = os.path.join(rd, 'telemetry', f"{d}_{lap_num}.json")
                        write_json_atomic(path, tel)
                        tel_count += 1
                except Exception:
                    pass

            try:
                set_job(year, rnd, 'rebuilding_telemetry_index', 0.90, 'Rebuilding telemetry index from cache...')
                rebuilt_tel_index = rebuild_telemetry_index_from_cache(rd, summary)
                write_json_atomic(os.path.join(rd, 'telemetry_index.json'), rebuilt_tel_index)
                if rebuilt_tel_index.get('generated_files'):
                    manifest['available']['telemetry'] = True
            except Exception as tel_idx_exc:
                warnings.append(f'telemetry index rebuild failed: {tel_idx_exc}')

            if tel_count > 0:
                manifest['available']['telemetry'] = True

        # Final manifest
        manifest['status'] = 'ready'
        manifest['generated_at'] = datetime.now(timezone.utc).isoformat()
        write_manifest(year, rnd, manifest)

        # Update summary with full data availability
        summary['has_track_map'] = manifest['available']['track_map']
        summary['has_telemetry'] = manifest['available']['telemetry']
        write_json_atomic(os.path.join(rd, 'summary.json'), summary)

        set_job(year, rnd, 'ready', 1.0, 'Ready')

    except Exception as e:
        set_job(year, rnd, 'failed', 0, f'Failed: {str(e)}')
        # Try to write failed manifest
        try:
            manifest = {
                'year': int(year), 'round': int(rnd), 'session': 'R',
                'status': 'failed',
                'generated_at': datetime.now(timezone.utc).isoformat(),
                'event_name': '',
                'cache_schema_version': 1,
                'available': {},
                'warnings': [str(e), traceback.format_exc()],
            }
            write_manifest(year, rnd, manifest)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Season overview from FastF1 schedule
# ---------------------------------------------------------------------------

def get_fastf1_season(year):
    """Get season schedule from FastF1."""
    cached = cache_get(f'fastf1_season:{year}')
    if cached:
        return cached

    try:
        schedule = fastf1.get_event_schedule(int(year), include_testing=False)
        races = []
        for _, row in schedule.iterrows():
            rnd = int(row.get('RoundNumber', 0))
            if rnd == 0:
                continue  # skip testing
            rd = race_dir(year, rnd)
            manifest = read_manifest(year, rnd)
            status = manifest.get('status', 'missing') if manifest else 'missing'

            races.append({
                'round': rnd,
                'name': safe_str(row.get('EventName'), ''),
                'circuit': safe_str(row.get('CircuitShortName'), ''),
                'country': safe_str(row.get('Country'), ''),
                'date': safe_str(row.get('EventDate'), ''),
                'location': safe_str(row.get('Location'), ''),
                'winner': None,
                'winner_team': None,
                'fastf1_status': status,
            })
        result = {'races': races}
        cache_set(f'fastf1_season:{year}', result)
        return result
    except Exception:
        return None

# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class F1Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        qs = parse_qs(parsed.query)

        try:
            if path == '/health':
                self._json({'ok': True, 'cache_root': CACHE_ROOT, 'jobs': len(_jobs)})

            elif path.startswith('/season/'):
                year = int(path.split('/')[2])
                data = get_fastf1_season(year)
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Season not found'}, 404)

            elif '/manifest' in path:
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                manifest = read_manifest(year, rnd)
                job = get_job(year, rnd)
                if manifest:
                    # Merge live job progress
                    if job and job.get('status') in ('running', 'loading_session', 'extracting_results',
                                                      'extracting_laps', 'extracting_strategy',
                                                      'extracting_weather', 'extracting_race_control',
                                                      'extracting_telemetry', 'extracting_track_map',
                                                      'extracting_telemetry_index', 'extracting_telemetry_files',
                                                      'loading_telemetry'):
                        manifest['status'] = 'running'
                        manifest['progress'] = job.get('progress', 0)
                        manifest['message'] = job.get('message', '')
                    self._json(manifest)
                elif job:
                    self._json({'status': job.get('status', 'unknown'), 'progress': job.get('progress', 0),
                                'message': job.get('message', ''), 'available': {}})
                else:
                    self._json({'status': 'missing', 'progress': 0, 'message': 'Not prepared', 'available': {}})

            elif path.startswith('/race/') and path.endswith('/laps'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'laps.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Laps not ready', 'hint': 'Call prepare first'}, 404)

            elif path.startswith('/race/') and path.endswith('/strategy'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'strategy.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Strategy not ready'}, 404)

            elif path.startswith('/race/') and path.endswith('/weather'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'weather.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Weather not ready'}, 404)

            elif path.startswith('/race/') and path.endswith('/race-control'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'race_control.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Race control not ready'}, 404)

            elif path.startswith('/race/') and path.endswith('/track-map'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'track_map.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Track map not ready'}, 404)

            elif path.startswith('/race/') and path.endswith('/telemetry-index'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                data = read_json(os.path.join(race_dir(year, rnd), 'telemetry_index.json'))
                if data:
                    self._json(data)
                else:
                    self._json({'error': 'Telemetry index not ready'}, 404)

            elif path.startswith('/race/') and '/telemetry' in path and not path.endswith('/telemetry-index'):
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                driver = qs.get('driver', [None])[0]
                lap = qs.get('lap', [None])[0]
                if not driver or not lap:
                    self._json({'error': 'Missing driver or lap query param'}, 400)
                    return

                # Try cached file first
                tel_path = os.path.join(race_dir(year, rnd), 'telemetry', f'{driver}_{lap}.json')
                data = read_json(tel_path)
                if data:
                    self._json(data)
                else:
                    self._json({'error': f'Telemetry not available for {driver} lap {lap}',
                                'hint': 'May need to regenerate with telemetry for this lap'}, 404)

            elif path.startswith('/race/') and not any(path.endswith(s) for s in ['/laps', '/strategy', '/weather', '/race-control', '/track-map', '/telemetry-index']):
                # /race/:year/:round - main race detail
                parts = path.split('/')
                if len(parts) >= 4:
                    year, rnd = int(parts[2]), int(parts[3])
                    rd = race_dir(year, rnd)

                    # Try to return summary + results from cache
                    summary = read_json(os.path.join(rd, 'summary.json'))
                    results_data = read_json(os.path.join(rd, 'results.json'))
                    laps_data = read_json(os.path.join(rd, 'laps.json'))
                    strategy_data = read_json(os.path.join(rd, 'strategy.json'))

                    manifest = read_manifest(year, rnd)
                    fastf1_status = manifest.get('status', 'missing') if manifest else 'missing'

                    if summary and results_data:
                        # Return cached FastF1 data
                        self._json({
                            'name': summary.get('name', ''),
                            'year': int(year),
                            'round': int(rnd),
                            'circuit': summary.get('circuit', ''),
                            'date': summary.get('date', ''),
                            'total_laps': summary.get('total_laps', 0),
                            'fastest_lap': summary.get('fastest_lap'),
                            'results': results_data.get('results', []),
                            'laps': laps_data.get('laps', []) if laps_data else [],
                            'strategy': strategy_data.get('strategy', []) if strategy_data else [],
                            'weather': [],
                            'race_control': [],
                            'telemetry': {},
                            'fastf1_status': fastf1_status,
                            'fastf1_ready': fastf1_status == 'ready',
                            'fastf1_source': 'fastf1',
                            'detail_endpoints': {
                                'manifest': f'/api/f1/race/{year}/{rnd}/manifest',
                                'laps': f'/api/f1/race/{year}/{rnd}/laps',
                                'strategy': f'/api/f1/race/{year}/{rnd}/strategy',
                                'weather': f'/api/f1/race/{year}/{rnd}/weather',
                                'raceControl': f'/api/f1/race/{year}/{rnd}/race-control',
                                'trackMap': f'/api/f1/race/{year}/{rnd}/track-map',
                                'telemetryIndex': f'/api/f1/race/{year}/{rnd}/telemetry-index',
                            }
                        })
                    else:
                        # Not cached yet — return minimal info
                        self._json({
                            'name': f'Race {rnd}',
                            'year': int(year),
                            'round': int(rnd),
                            'circuit': '',
                            'date': '',
                            'total_laps': 0,
                            'fastest_lap': None,
                            'results': [],
                            'laps': [],
                            'strategy': [],
                            'weather': [],
                            'race_control': [],
                            'telemetry': {},
                            'fastf1_status': fastf1_status,
                            'fastf1_ready': False,
                            'fastf1_source': 'none',
                            'detail_endpoints': {
                                'manifest': f'/api/f1/race/{year}/{rnd}/manifest',
                                'laps': f'/api/f1/race/{year}/{rnd}/laps',
                                'strategy': f'/api/f1/race/{year}/{rnd}/strategy',
                                'weather': f'/api/f1/race/{year}/{rnd}/weather',
                                'raceControl': f'/api/f1/race/{year}/{rnd}/race-control',
                                'trackMap': f'/api/f1/race/{year}/{rnd}/track-map',
                                'telemetryIndex': f'/api/f1/race/{year}/{rnd}/telemetry-index',
                            }
                        })
                else:
                    self._json({'error': 'Invalid race path'}, 400)
            else:
                self._json({'error': 'Not found'}, 404)

        except Exception as e:
            self._json({'error': str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')

        try:
            if '/prepare' in path:
                parts = path.split('/')
                year, rnd = int(parts[2]), int(parts[3])
                key = job_key(year, rnd)

                with _jobs_lock:
                    existing = _jobs.get(key)
                    if existing and existing.get('status') not in ('missing', 'failed', 'ready', ''):
                        self._json({'status': existing['status'], 'message': f'Already {existing["status"]}'})
                        return

                set_job(year, rnd, 'queued', 0, 'Queued for preparation')
                thread = threading.Thread(target=prepare_race, args=(year, rnd), daemon=True)
                thread.start()
                self._json({'status': 'queued', 'message': 'FastF1 preparation started'})
            else:
                self._json({'error': 'Not found'}, 404)

        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, data, status=200):
        body = json.dumps(data, default=_json_default).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # suppress default logging


if __name__ == '__main__':
    print(f'🏎️  FastF1 backend on port {PORT}')
    print(f'📁 Cache root: {CACHE_ROOT}')
    server = HTTPServer(('127.0.0.1', PORT), F1Handler)
    server.serve_forever()
