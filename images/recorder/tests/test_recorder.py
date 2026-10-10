"""The recorder against snapshot files: no network, no clock of its own."""
import datetime as dt
import json
import os
from pathlib import Path

import duckdb
import pytest

import recorder

FEED_SQL = Path(os.environ.get('RECORDER_FEEDS', '/repo/recorder/feeds')) / 'flights.sql'
BASE = 'http://feeds/recordings'
T0 = dt.datetime(2026, 10, 10, 14, 3, 0, tzinfo=dt.timezone.utc)


def aircraft(hex_, lat, lon, alt=35000, seen_pos=0.5, **extra):
    return {'hex': hex_, 'flight': f'TST{hex_[-3:]}  ', 'r': 'EC-ABC', 't': 'A320', 'category': 'A3',
            'type': 'adsb_icao', 'lat': lat, 'lon': lon, 'alt_baro': alt, 'alt_geom': 36000,
            'baro_rate': 0, 'gs': 450.5, 'track': 90.0, 'squawk': '1000', 'emergency': 'none',
            'seen_pos': seen_pos, **extra}


def snapshot(path, at, planes):
    path.write_text(json.dumps({'now': at.timestamp() * 1000, 'ac': planes}))


@pytest.fixture
def env(tmp_path):
    source = tmp_path / 'snap.json'
    data = tmp_path / 'data'
    health = tmp_path / 'ok'

    def make(retention_days=7):
        return recorder.Feed(FEED_SQL, data, BASE, retention_days, source=str(source), interval=60,
                             health_file=health)
    return source, data, health, make


def files(data, pattern='*-*-*/*'):
    return sorted(p.relative_to(data / 'flights').as_posix() for p in (data / 'flights').glob(pattern))


def rows(path):
    return duckdb.sql(f"SELECT * FROM read_parquet('{path}') ORDER BY hex").fetchall()


def test_a_poll_writes_one_minute_file_with_the_feed_columns(env):
    source, data, health, make = env
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0), aircraft('aaa002', 41.0, 2.0)])
    make().poll(T0)
    assert files(data) == ['2026-10-10/h14-m0300.parquet']
    described = duckdb.sql(f"DESCRIBE SELECT * FROM '{data}/flights/2026-10-10/h14-m0300.parquet'").fetchall()
    assert [(c[0], c[1]) for c in described] == [
        ('ts', 'TIMESTAMP WITH TIME ZONE'), ('hex', 'VARCHAR'), ('flight', 'VARCHAR'), ('reg', 'VARCHAR'),
        ('type', 'VARCHAR'), ('category', 'VARCHAR'), ('source', 'VARCHAR'), ('lat', 'DOUBLE'),
        ('lon', 'DOUBLE'), ('cell', 'UBIGINT'), ('alt_baro', 'INTEGER'), ('on_ground', 'BOOLEAN'),
        ('alt_geom', 'INTEGER'), ('baro_rate', 'INTEGER'), ('gs', 'DOUBLE'), ('track', 'DOUBLE'),
        ('squawk', 'VARCHAR'), ('emergency', 'VARCHAR'), ('db_flags', 'INTEGER')]
    assert len(rows(data / 'flights/2026-10-10/h14-m0300.parquet')) == 2
    assert health.exists()


def test_ground_is_null_altitude_and_on_ground(env):
    source, data, _, make = env
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0, alt='ground')])
    make().poll(T0)
    (row,) = duckdb.sql(f"SELECT alt_baro, on_ground FROM '{data}/flights/2026-10-10/*.parquet'").fetchall()
    assert row == (None, True)


def test_a_position_not_heard_again_is_not_written_twice(env):
    source, data, _, make = env
    feed = make()
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0), aircraft('aaa002', 41.0, 2.0, seen_pos=1)])
    feed.poll(T0)
    # A minute later aaa001 moved; aaa002's last position is the same one, 61 s old.
    t1 = T0 + dt.timedelta(minutes=1)
    snapshot(source, t1, [aircraft('aaa001', 40.1, -3.0), aircraft('aaa002', 41.0, 2.0, seen_pos=61)])
    feed.poll(t1)
    second = rows(data / 'flights/2026-10-10/h14-m0400.parquet')
    assert [r[1] for r in second] == ['aaa001']


def test_nothing_new_writes_no_file(env):
    source, data, _, make = env
    feed = make()
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0)])
    feed.poll(T0)
    t1 = T0 + dt.timedelta(minutes=1)
    snapshot(source, t1, [aircraft('aaa001', 40.0, -3.0, seen_pos=60.5)])
    feed.poll(t1)
    assert files(data) == ['2026-10-10/h14-m0300.parquet']


def test_a_new_hour_merges_the_last_one_sorted(env):
    source, data, _, make = env
    feed = make()
    for minute, lat in ((3, 40.0), (4, 40.1), (5, 40.2)):
        t = T0.replace(minute=minute)
        snapshot(source, t, [aircraft('bbb001', lat, 100.0), aircraft('aaa001', lat, -3.0)])
        feed.poll(t)
    t = T0.replace(hour=15, minute=0)
    snapshot(source, t, [aircraft('aaa001', 41.0, -3.0)])
    feed.poll(t)
    merged = data / 'flights/2026-10-10/h14.parquet'
    assert merged.exists()
    assert duckdb.sql(f"SELECT * FROM '{merged}'").columns == duckdb.sql(
        f"SELECT * FROM '{data}/flights/2026-10-10/h15-m0000.parquet'").columns
    order = duckdb.sql(f"SELECT cell, hex, ts FROM '{merged}'").fetchall()
    assert order == sorted(order)
    assert len(order) == 6
    # The manifest stops naming the minute files at once; they go on the next poll.
    manifest = json.loads((data / 'flights/manifest.json').read_text())
    assert [e['url'].rsplit('/', 1)[1] for e in manifest] == ['h14.parquet', 'h15-m0000.parquet']
    t = T0.replace(hour=15, minute=1)
    snapshot(source, t, [aircraft('aaa001', 41.1, -3.0)])
    feed.poll(t)
    assert files(data) == ['2026-10-10/h14.parquet', '2026-10-10/h15-m0000.parquet',
                           '2026-10-10/h15-m0100.parquet']


def test_a_restart_merges_what_a_crash_left(env):
    source, data, _, make = env
    feed = make()
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0)])
    feed.poll(T0)
    later = T0.replace(hour=16, minute=10)
    make().recover(later)
    assert files(data) == ['2026-10-10/h14.parquet']


def test_retention_keeps_today_and_the_days_before(env):
    source, data, _, make = env
    feed = make(retention_days=2)
    for day in (7, 8, 9, 10):
        t = T0.replace(day=day)
        snapshot(source, t, [aircraft('aaa001', 40.0 + day / 10, -3.0)])
        feed.poll(t)
    t = T0.replace(minute=30)
    snapshot(source, t, [aircraft('aaa001', 42.0, -3.0)])
    feed.poll(t)
    manifest = json.loads((data / 'flights/manifest.json').read_text())
    assert {e['url'].split('/')[-2] for e in manifest} == {'2026-10-08', '2026-10-09', '2026-10-10'}
    t = T0.replace(minute=31)
    snapshot(source, t, [aircraft('aaa001', 42.1, -3.0)])
    feed.poll(t)
    assert not (data / 'flights/2026-10-07').exists()


def test_the_manifest_names_every_file_with_its_hour(env):
    source, data, _, make = env
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0)])
    make().poll(T0)
    manifest = json.loads((data / 'flights/manifest.json').read_text())
    assert manifest == [{'url': f'{BASE}/flights/2026-10-10/h14-m0300.parquet',
                         'from': '2026-10-10T14:00:00Z', 'to': '2026-10-10T15:00:00Z'}]


def test_a_failing_source_is_logged_and_writes_nothing(env):
    source, data, health, make = env
    make().poll(T0)  # source file does not exist
    assert files(data) == []
    assert not health.exists()
    (poll,) = duckdb.sql(f"SELECT status, received, written, error FROM '{data}/flights/polls.parquet'").fetchall()
    assert poll[0] == 'error' and poll[1:3] == (0, 0) and poll[3]


def test_polls_are_logged(env):
    source, data, _, make = env
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0), aircraft('aaa002', 41.0, 2.0)])
    make().poll(T0)
    (poll,) = duckdb.sql(f"SELECT status, received, written FROM '{data}/flights/polls.parquet'").fetchall()
    assert poll == ('ok', 2, 2)


def test_no_tmp_file_is_ever_left(env):
    source, data, _, make = env
    feed = make()
    for minute in (3, 4):
        t = T0.replace(minute=minute)
        snapshot(source, t, [aircraft('aaa001', 40.0 + minute, -3.0)])
        feed.poll(t)
    t = T0.replace(hour=15)
    snapshot(source, t, [aircraft('aaa001', 45.0, -3.0)])
    feed.poll(t)
    assert not [p for p in data.rglob('*') if p.name.endswith('.tmp')]


def test_files_are_readable_by_another_user(env):
    source, data, _, make = env
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0)])
    make().poll(T0)
    for path in (data / 'flights').rglob('*'):
        mode = path.stat().st_mode & 0o777
        assert mode == (0o755 if path.is_dir() else 0o644), path


def test_a_url_source_is_downloaded_whole_each_poll(tmp_path):
    # A feed that changes size between polls, served over HTTP as the gateway serves it.
    import functools
    import http.server
    import threading
    served = tmp_path / 'www'
    served.mkdir()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(served))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f'http://127.0.0.1:{server.server_port}/world'
        feed = recorder.Feed(FEED_SQL, tmp_path / 'data', BASE, 7, source=url, interval=60)
        snapshot(served / 'world', T0, [aircraft(f'aaa{i:03}', 40.0, -3.0 + i / 10) for i in range(50)])
        feed.poll(T0)
        t1 = T0 + dt.timedelta(minutes=1)
        snapshot(served / 'world', t1, [aircraft('bbb001', 41.0, 2.0)])
        feed.poll(t1)
        polls = duckdb.sql(f"SELECT status, received FROM '{tmp_path}/data/flights/polls.parquet' ORDER BY ts").fetchall()
        assert polls == [('ok', 50), ('ok', 1)]
    finally:
        server.shutdown()


def test_an_hour_merges_files_from_before_a_column_was_added(env):
    source, data, _, make = env
    feed = make()
    snapshot(source, T0, [aircraft('aaa001', 40.0, -3.0)])
    feed.poll(T0)
    old = data / 'flights/2026-10-10/h14-m0300.parquet'
    duckdb.sql(f"COPY (SELECT * EXCLUDE (db_flags) FROM '{old}') TO '{old}.x' (FORMAT parquet)")
    os.replace(f'{old}.x', old)
    t = T0.replace(minute=4)
    snapshot(source, t, [aircraft('aaa001', 40.1, -3.0, dbFlags=1)])
    feed.poll(t)
    t = T0.replace(hour=15)
    snapshot(source, t, [aircraft('aaa001', 41.0, -3.0)])
    feed.poll(t)
    flags = duckdb.sql(f"SELECT db_flags FROM '{data}/flights/2026-10-10/h14.parquet' ORDER BY ts").fetchall()
    assert flags == [(None,), (1,)]
