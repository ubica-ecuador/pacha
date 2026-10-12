"""The daily recorder against zipped CSV days built here: no network, no clock of its own."""
import datetime as dt
import json
import math
import os
import zipfile
from pathlib import Path

import duckdb
import pytest

import recorder

FEED_SQL = Path(os.environ.get('RECORDER_FEEDS', '/repo/recorder/feeds')) / 'ais-denmark.sql'
BASE = 'http://feeds/recordings'
DAY = dt.date(2026, 10, 8)
NOW = dt.datetime(2026, 10, 11, 1, 0, tzinfo=dt.timezone.utc)
TABLES = ['vessels', 'tracks', 'stops', 'trips', 'encounters', 'cells']
HEADER = ('# Timestamp,Type of mobile,MMSI,Latitude,Longitude,Navigational status,ROT,SOG,COG,Heading,IMO,'
          'Callsign,Name,Ship type,Cargo type,Width,Length,Type of position fixing device,Draught,'
          'Destination,ETA,Data source type,A,B,C,D')


def row(at, mmsi, lat, lon, sog, nav='Under way using engine', ship_type='Cargo', name='TEST',
        mobile='Class A'):
    return (f'{at:%d/%m/%Y %H:%M:%S},{mobile},{mmsi},{lat:.6f},{lon:.6f},{nav},0.0,{sog},90.0,90,'
            f'Unknown,Unknown,{name},{ship_type},,20,120,GPS,6.0,COPENHAGEN,,AIS,,,,')


def every_30s(day, start_h, end_h):
    t = dt.datetime.combine(day, dt.time()) + dt.timedelta(hours=start_h)
    while t < dt.datetime.combine(day, dt.time()) + dt.timedelta(hours=end_h):
        yield t
        t += dt.timedelta(seconds=30)


def ais_day(path, day):
    """A cargo ship moored, then 4 h at 12 kn east, then moored again; a fishing boat
    and a cargo ship drifting together at sea for 2.5 h; and a base station."""
    lines = [HEADER]
    east_per_hour = 12 * 1852 / (111320 * math.cos(math.radians(55.68)))
    for t in every_30s(day, 0, 24):
        h = (t - dt.datetime.combine(day, dt.time())).total_seconds() / 3600
        if h < 6:
            lines.append(row(t, 211000001, 55.68, 12.60, 0.0, nav='Moored', name='MOVER'))
        elif h < 10:
            lines.append(row(t, 211000001, 55.68, 12.60 + east_per_hour * (h - 6), 12.0, name='MOVER'))
        else:
            lines.append(row(t, 211000001, 55.68, 12.60 + east_per_hour * 4, 0.0, nav='Moored', name='MOVER'))
    for t in every_30s(day, 12, 14.5):
        h = (t - dt.datetime.combine(day, dt.time())).total_seconds() / 3600
        north = (h - 12) * 1852 / 111320
        lines.append(row(t, 219000002, 56.5 + north, 7.0, 1.0, ship_type='Fishing', name='TRAWLER'))
        lines.append(row(t, 219000003, 56.5 + north, 7.0015, 1.0, name='CARRIER'))
    lines.append(row(dt.datetime.combine(day, dt.time()), 2190064, 55.0, 12.0, 0.0, mobile='Base Station'))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(f'aisdk-{day}.csv', '\n'.join(lines) + '\n')


@pytest.fixture
def env(tmp_path):
    published = tmp_path / 'published'
    published.mkdir()
    data = tmp_path / 'data'

    def make(retention_days=7):
        return recorder.DailyFeed(FEED_SQL, data, BASE, retention_days,
                                  source=str(published / 'aisdk-{day}.zip'), scratch=str(tmp_path))
    return published, data, make


def publish(published, *days):
    for day in days:
        ais_day(published / f'aisdk-{day}.zip', day)


def days_kept(data):
    return sorted(p.name for p in (data / 'ais-denmark').iterdir() if p.is_dir())


def test_a_published_day_is_read_into_every_table(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    assert days_kept(data) == ['2026-10-08']
    assert sorted(p.stem for p in (data / 'ais-denmark/2026-10-08').iterdir()) == sorted(TABLES)
    manifest = json.loads((data / 'ais-denmark/manifest.json').read_text())
    assert {(e['day'], e['table']) for e in manifest} == {('2026-10-08', t) for t in TABLES}
    assert manifest[0]['url'].startswith(f'{BASE}/ais-denmark/2026-10-08/')


def test_ships_only_with_what_they_say_of_themselves(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    vessels = duckdb.sql(f"SELECT mmsi, name, kind FROM '{data}/ais-denmark/2026-10-08/vessels.parquet' "
                         'ORDER BY mmsi').fetchall()
    assert vessels == [(211000001, 'MOVER', 'Cargo'), (219000002, 'TRAWLER', 'Fishing'),
                       (219000003, 'CARRIER', 'Cargo')]


def test_two_stops_and_the_trip_between_them(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    stops = duckdb.sql(f"SELECT how, minutes, cut_start, cut_end FROM '{data}/ais-denmark/2026-10-08/stops.parquet' "
                       'WHERE mmsi = 211000001 ORDER BY start_ts').fetchall()
    assert [s[0] for s in stops] == ['Moored', 'Moored']
    assert stops[0][2] and not stops[0][3] and stops[1][3] and not stops[1][2]
    (trip,) = duckdb.sql(f"SELECT km, avg_kn, from_place IS NOT NULL, to_place IS NOT NULL, cut_start, cut_end "
                         f"FROM '{data}/ais-denmark/2026-10-08/trips.parquet' WHERE mmsi = 211000001").fetchall()
    assert 85 < trip[0] < 92 and 11 < trip[1] < 13
    assert trip[2:] == (True, True, False, False)
    tracks = duckdb.sql(f"SELECT count(trip_id), count(stop_id) FROM '{data}/ais-denmark/2026-10-08/tracks.parquet' "
                        'WHERE mmsi = 211000001').fetchone()
    assert tracks[0] > 400 and tracks[1] > 2000


def test_ships_drifting_together_at_sea_meet(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    (meet,) = duckdb.sql(f"SELECT mmsi_a, mmsi_b, minutes, closest_m, with_service "
                         f"FROM '{data}/ais-denmark/2026-10-08/encounters.parquet'").fetchall()
    assert meet[:2] == (219000002, 219000003)
    assert meet[2] >= 140 and 80 < meet[3] < 110 and meet[4] is False


def test_hours_of_presence_add_up(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    (hours,) = duckdb.sql(f"SELECT sum(ship_hours) FROM '{data}/ais-denmark/2026-10-08/cells.parquet'").fetchone()
    assert abs(hours - (24 + 2.5 + 2.5)) < 0.1


def test_a_day_not_published_yet_is_looked_for_again(env):
    published, data, make = env
    feed = make()
    feed.poll(NOW)
    assert days_kept(data) == []
    assert json.loads((data / 'ais-denmark/manifest.json').read_text()) == []
    publish(published, dt.date(2026, 10, 10))
    feed.poll(NOW + dt.timedelta(hours=1))
    assert days_kept(data) == ['2026-10-10']


def test_retention_keeps_the_newest_days_published(env):
    published, data, make = env
    publish(published, *(dt.date(2026, 10, d) for d in (6, 7, 8)))
    make(retention_days=2).poll(NOW)
    assert days_kept(data) == ['2026-10-07', '2026-10-08']
    publish(published, dt.date(2026, 10, 9))
    make(retention_days=2).poll(NOW)
    assert days_kept(data) == ['2026-10-08', '2026-10-09']


def test_a_failed_day_is_logged_and_tried_again_a_day_later(env):
    published, data, make = env
    (published / f'aisdk-{DAY}.zip').write_text('not a zip')
    feed = make()
    feed.poll(NOW)
    assert days_kept(data) == []
    (log,) = duckdb.sql(f"SELECT day, status, error IS NOT NULL FROM '{data}/ais-denmark/polls.parquet'").fetchall()
    assert log == (DAY, 'error', True)
    publish(published, DAY)
    feed.poll(NOW + dt.timedelta(hours=1))
    assert days_kept(data) == []
    feed.poll(NOW + dt.timedelta(days=1, hours=1))
    assert days_kept(data) == ['2026-10-08']


def test_a_day_left_half_written_is_dropped_at_start(env):
    published, data, make = env
    half = data / 'ais-denmark/2026-10-08.tmp'
    half.mkdir(parents=True)
    (half / 'vessels.parquet').write_text('')
    make().recover(NOW)
    assert not half.exists()
    assert json.loads((data / 'ais-denmark/manifest.json').read_text()) == []


def test_files_are_readable_by_another_user(env):
    published, data, make = env
    publish(published, DAY)
    make().poll(NOW)
    for path in (data / 'ais-denmark').rglob('*'):
        mode = path.stat().st_mode & 0o777
        assert mode == (0o755 if path.is_dir() else 0o644), path


def test_a_url_answering_404_is_a_day_not_published(tmp_path):
    import functools
    import http.server
    import threading
    served = tmp_path / 'www'
    served.mkdir()
    ais_day(served / 'aisdk-2026-10-10.zip', dt.date(2026, 10, 10))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(served))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f'http://127.0.0.1:{server.server_port}/aisdk-{{day}}.zip'
        recorder.DailyFeed(FEED_SQL, tmp_path / 'data', BASE, 7, source=url, scratch=str(tmp_path)).poll(NOW)
        assert days_kept(tmp_path / 'data') == ['2026-10-10']
        statuses = duckdb.sql(f"SELECT status FROM '{tmp_path}/data/ais-denmark/polls.parquet'").fetchall()
        assert statuses == [('ok',)]
    finally:
        server.shutdown()


def test_a_download_cut_short_is_tried_again_the_next_interval(tmp_path):
    import http.server
    import threading
    whole = tmp_path / 'whole.zip'
    ais_day(whole, dt.date(2026, 10, 10))
    body = whole.read_bytes()
    cut = {'short': True}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.endswith('2026-10-10.zip'):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body[:len(body) // 2] if cut['short'] else body)
            self.close_connection = True

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f'http://127.0.0.1:{server.server_port}/aisdk-{{day}}.zip'
        feed = recorder.DailyFeed(FEED_SQL, tmp_path / 'data', BASE, 7, source=url, scratch=str(tmp_path))
        feed.poll(NOW)
        assert days_kept(tmp_path / 'data') == []
        cut['short'] = False
        feed.poll(NOW + dt.timedelta(hours=1))
        assert days_kept(tmp_path / 'data') == ['2026-10-10']
        statuses = duckdb.sql(f"SELECT status FROM '{tmp_path}/data/ais-denmark/polls.parquet' ORDER BY ts").fetchall()
        assert statuses == [('unreachable',), ('ok',)]
    finally:
        server.shutdown()
