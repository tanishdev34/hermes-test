#!/usr/bin/env python3
"""FastF1 telemetry backend — optimized for speed."""
import json
import sys
import os
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

os.environ['FASTF1_CACHE'] = '/tmp/fastf1_cache'
os.makedirs('/tmp/fastf1_cache', exist_ok=True)

import fastf1
import pandas as pd

PORT = int(os.environ.get('F1_PORT', 4000))

# In-memory cache
_cache = {}
_cache_lock = threading.Lock()

def cache_get(key):
    with _cache_lock:
        return _cache.get(key)

def cache_set(key, val):
    with _cache_lock:
        _cache[key] = val

def get_season_overview(year):
    """Get race schedule ONLY — no per-race loading. Super fast."""
    cached = cache_get(f'season:{year}')
    if cached:
        return cached

    schedule = fastf1.get_event_schedule(int(year), include_testing=False)
    races = []
    for _, row in schedule.iterrows():
        races.append({
            'round': int(row.get('RoundNumber', 0)),
            'name': str(row.get('EventName', '')),
            'circuit': str(row.get('CircuitShortName', '')),
            'country': str(row.get('Country', '')),
            'date': str(row.get('EventDate', '')),
            'location': str(row.get('Location', '')),
            'winner': None,
            'winner_team': None,
        })

    result = {'races': races, 'driver_standings': []}
    cache_set(f'season:{year}', result)
    return result

def get_race_detail(year, round_num):
    """Get full race detail with laps, telemetry, strategy."""
    cache_key = f'race:{year}:{round_num}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    try:
        event = fastf1.get_event(int(year), int(round_num))
        session = event.get_race()
        session.load(laps=True, telemetry=True, weather=True, messages=True)
    except Exception as e:
        return {'error': f'Failed to load race: {str(e)}'}

    result = {
        'name': str(session.event.get('EventName', '')),
        'circuit': str(session.event.get('CircuitShortName', '')),
        'date': str(session.event.get('EventDate', '')),
        'total_laps': int(session.total_laps) if session.total_laps else 0,
        'results': [],
        'laps': [],
        'strategy': [],
        'fastest_lap': None,
        'weather': [],
        'race_control': [],
    }

    # Results
    if session.results is not None:
        for _, r in session.results.iterrows():
            result['results'].append({
                'position': int(r.get('Position', 0)) if pd.notna(r.get('Position')) else 0,
                'driver': f"{r.get('FirstName', '')} {r.get('LastName', '')}".strip(),
                'abbreviation': str(r.get('Abbreviation', '')),
                'number': str(r.get('DriverNumber', '')),
                'team': str(r.get('TeamName', '')),
                'color': f"#{r.get('TeamColor', 'fff')}",
                'grid': int(r.get('GridPosition', 0)) if pd.notna(r.get('GridPosition')) else 0,
                'time': str(r.get('Time', '')) if pd.notna(r.get('Time')) else '',
                'status': str(r.get('Status', '')),
                'points': float(r.get('Points', 0)) if pd.notna(r.get('Points')) else 0,
                'laps': int(r.get('Laps', 0)) if pd.notna(r.get('Laps')) else 0,
            })

    # Lap data (position per lap for chart)
    if session.laps is not None:
        for _, lap in session.laps.iterrows():
            lap_data = {
                'driver': str(lap.get('Driver', '')),
                'lap': int(lap.get('LapNumber', 0)) if pd.notna(lap.get('LapNumber')) else 0,
                'position': int(lap.get('Position', 0)) if pd.notna(lap.get('Position')) else 0,
                'lap_time': str(lap.get('LapTime', '')) if pd.notna(lap.get('LapTime')) else '',
                'sector1': str(lap.get('Sector1Time', '')) if pd.notna(lap.get('Sector1Time')) else '',
                'sector2': str(lap.get('Sector2Time', '')) if pd.notna(lap.get('Sector2Time')) else '',
                'sector3': str(lap.get('Sector3Time', '')) if pd.notna(lap.get('Sector3Time')) else '',
                'compound': str(lap.get('Compound', '')),
                'tyre_life': int(lap.get('TyreLife', 0)) if pd.notna(lap.get('TyreLife')) else 0,
                'speed_fl': float(lap.get('SpeedFL', 0)) if pd.notna(lap.get('SpeedFL')) else 0,
            }
            result['laps'].append(lap_data)

    # Strategy
    if session.laps is not None:
        drivers = session.laps['Driver'].unique()
        for driver in drivers:
            driver_laps = session.laps[session.laps['Driver'] == driver]
            stints = []
            stint_groups = driver_laps.groupby('Stint')
            for stint_num, stint_data in stint_groups:
                stints.append({
                    'stint': int(stint_num) if pd.notna(stint_num) else 0,
                    'compound': str(stint_data['Compound'].iloc[0]) if len(stint_data) > 0 else '',
                    'start_lap': int(stint_data['LapNumber'].min()) if len(stint_data) > 0 else 0,
                    'end_lap': int(stint_data['LapNumber'].max()) if len(stint_data) > 0 else 0,
                    'laps': len(stint_data),
                    'tyre_age': int(stint_data['TyreLife'].max()) if len(stint_data) > 0 else 0,
                })
            driver_info = next((r for r in result['results'] if r['abbreviation'] == driver), {})
            result['strategy'].append({
                'driver': driver_info.get('driver', driver),
                'abbreviation': driver,
                'team': driver_info.get('team', ''),
                'color': driver_info.get('color', '#fff'),
                'stints': stints,
            })

    # Fastest lap
    try:
        fastest = session.laps.pick_fastest()
        if fastest is not None:
            driver_info = next((r for r in result['results'] if r['abbreviation'] == fastest.get('Driver', '')), {})
            result['fastest_lap'] = {
                'driver': driver_info.get('driver', str(fastest.get('Driver', ''))),
                'team': driver_info.get('team', ''),
                'time': str(fastest.get('LapTime', '')),
                'lap': int(fastest.get('LapNumber', 0)) if pd.notna(fastest.get('LapNumber')) else 0,
                'speed_fl': float(fastest.get('SpeedFL', 0)) if pd.notna(fastest.get('SpeedFL')) else 0,
                'sector1': str(fastest.get('Sector1Time', '')) if pd.notna(fastest.get('Sector1Time')) else '',
                'sector2': str(fastest.get('Sector2Time', '')) if pd.notna(fastest.get('Sector2Time')) else '',
                'sector3': str(fastest.get('Sector3Time', '')) if pd.notna(fastest.get('Sector3Time')) else '',
                'compound': str(fastest.get('Compound', '')),
            }
    except Exception:
        pass

    # Weather
    if session.weather_data is not None:
        for _, w in session.weather_data.head(20).iterrows():
            result['weather'].append({
                'air_temp': float(w.get('AirTemp', 0)) if pd.notna(w.get('AirTemp')) else 0,
                'track_temp': float(w.get('TrackTemp', 0)) if pd.notna(w.get('TrackTemp')) else 0,
                'humidity': float(w.get('Humidity', 0)) if pd.notna(w.get('Humidity')) else 0,
                'wind_speed': float(w.get('WindSpeed', 0)) if pd.notna(w.get('WindSpeed')) else 0,
                'rainfall': bool(w.get('Rainfall', False)),
            })

    # Race control messages
    if session.race_control_messages is not None:
        for _, msg in session.race_control_messages.head(30).iterrows():
            result['race_control'].append({
                'time': str(msg.get('Time', '')) if pd.notna(msg.get('Time')) else '',
                'message': str(msg.get('Message', '')),
                'category': str(msg.get('Category', '')),
                'flag': str(msg.get('Flag', '')) if pd.notna(msg.get('Flag')) else '',
            })

    # Telemetry for top 3 drivers (fastest lap)
    result['telemetry'] = {}
    for r in result['results'][:3]:
        try:
            driver_laps = session.laps.pick_drivers(r['abbreviation'])
            fastest_lap = driver_laps.pick_fastest()
            if fastest_lap is not None:
                tel = fastest_lap.get_car_data()
                if tel is not None and len(tel) > 0:
                    tel_sampled = tel.iloc[::5]
                    result['telemetry'][r['abbreviation']] = {
                        'speed': tel_sampled['Speed'].tolist() if 'Speed' in tel_sampled.columns else [],
                        'throttle': tel_sampled['Throttle'].tolist() if 'Throttle' in tel_sampled.columns else [],
                        'brake': tel_sampled['Brake'].tolist() if 'Brake' in tel_sampled.columns else [],
                        'gear': tel_sampled['nGear'].tolist() if 'nGear' in tel_sampled.columns else [],
                        'rpm': tel_sampled['RPM'].tolist() if 'RPM' in tel_sampled.columns else [],
                        'drs': tel_sampled['DRS'].tolist() if 'DRS' in tel_sampled.columns else [],
                    }
        except Exception:
            pass

    cache_set(cache_key, result)
    return result


class F1Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path == '/health':
                data = {'ok': True}
            elif path.startswith('/season/'):
                year = int(path.split('/')[2])
                data = get_season_overview(year)
            elif path.startswith('/race/'):
                parts = path.split('/')
                year, round_num = int(parts[2]), int(parts[3])
                data = get_race_detail(year, round_num)
            else:
                self.send_response(404)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'Not found'}).encode())
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data, default=str).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, format, *args):
        pass

if __name__ == '__main__':
    print(f'🏎️  FastF1 backend on port {PORT}')
    server = HTTPServer(('127.0.0.1', PORT), F1Handler)
    server.serve_forever()
