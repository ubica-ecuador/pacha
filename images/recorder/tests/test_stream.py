"""The stream recorder against messages handed to it and a websocket served here: no network, no clock of its own."""
import datetime as dt
import json
import threading
import time

import duckdb
import pytest
from websockets.sync.server import serve

import recorder

BASE = 'http://feeds/recordings'
UTC = dt.timezone.utc
# Any stream: a reading per message, keys that not every message has.
FEED_SQL = """-- A test stream.
--
-- source: wss://stream.example/readings
-- schedule: stream
-- order: sensor, ts

SELECT json ->> 'sensor' AS sensor,
       (json ->> 'time')::TIMESTAMPTZ AS ts,
       (json ->> 'value')::DOUBLE AS value,
       json ->> 'unit' AS unit
FROM read_ndjson_objects(getvariable('source'))
"""


def message(sensor, at, value, **extra):
    return json.dumps({'sensor': sensor, 'time': at.isoformat(), 'value': value, **extra})


@pytest.fixture
def make(tmp_path):
    sql = tmp_path / 'feeds' / 'readings.sql'
    sql.parent.mkdir()
    sql.write_text(FEED_SQL)

    def make(source=None):
        return recorder.StreamFeed(sql, tmp_path / 'data', BASE, 7, source=source, interval=60,
                                   health_file=tmp_path / 'ok')
    return make


def rows(path):
    return duckdb.sql(f"SELECT sensor, ts, value, unit FROM read_parquet('{path}') ORDER BY ts").fetchall()


def polls(feed):
    return duckdb.sql(f"SELECT status, received, written FROM read_parquet('{feed.dir / 'polls.parquet'}') "
                      'ORDER BY ts').fetchall()


def test_messages_land_in_the_hour_their_time_falls_in(make):
    feed = make()
    feed.connected.set()
    t = dt.datetime(2026, 11, 12, 13, 59, 50, tzinfo=UTC)
    feed.receive(message('co2-1', t, 612, unit='ppm'))
    # Pretty-printed: still one message, and one without a unit.
    feed.receive(json.dumps({'sensor': 'co2-2', 'time': (t + dt.timedelta(seconds=20)).isoformat(), 'value': 580},
                            indent=2))
    # Older than the retention: kept nowhere.
    feed.receive(message('co2-1', t - dt.timedelta(days=30), 400))
    now = dt.datetime(2026, 11, 12, 14, 1, tzinfo=UTC)
    feed.poll(now)
    day = feed.dir / '2026-11-12'
    # Hour 13 is closed: its minute file is merged at once (and deleted a poll later).
    assert rows(day / 'h13.parquet') == [('co2-1', t, 612.0, 'ppm')]
    assert rows(day / 'h14-m0100.parquet') == [('co2-2', t + dt.timedelta(seconds=20), 580.0, None)]
    manifest = json.loads((feed.dir / 'manifest.json').read_text())
    assert [(e['url'].rsplit('/', 2)[-2:], e['from']) for e in manifest] == [
        (['2026-11-12', 'h13.parquet'], '2026-11-12T13:00:00Z'),
        (['2026-11-12', 'h14-m0100.parquet'], '2026-11-12T14:00:00Z'),
    ]
    assert polls(feed) == [('ok', 3, 2)]
    assert (feed.dir.parent.parent / 'ok').exists()


def test_a_message_from_a_clock_ahead_is_kept_in_this_hour(make):
    feed = make()
    feed.connected.set()
    now = dt.datetime(2026, 11, 12, 14, 1, tzinfo=UTC)
    feed.receive(message('co2-1', now + dt.timedelta(hours=2), 700))
    feed.poll(now)
    assert rows(feed.dir / '2026-11-12' / 'h14-m0100.parquet')[0][1] == now + dt.timedelta(hours=2)


def test_nothing_received_while_unconnected_is_a_poll_that_says_so(make, tmp_path):
    feed = make()
    feed.poll(dt.datetime(2026, 11, 12, 14, 1, tzinfo=UTC))
    assert polls(feed) == [('unreachable', 0, 0)]
    assert not (tmp_path / 'ok').exists()
    assert json.loads((feed.dir / 'manifest.json').read_text()) == []


def test_a_source_that_is_not_a_websocket_is_refused(make):
    with pytest.raises(ValueError, match='ws://'):
        make(source='https://stream.example/readings')


def test_listens_and_connects_again_when_the_socket_closes(make, monkeypatch):
    t = dt.datetime(2026, 11, 12, 14, 0, 5, tzinfo=UTC)
    connections = []

    def handler(socket):
        connections.append(socket)
        socket.send(message('co2-1', t + dt.timedelta(seconds=len(connections)), 600 + len(connections)))
        # Returning closes the socket.

    with serve(handler, '127.0.0.1', 0) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.socket.getsockname()[1]
        monkeypatch.setattr(recorder.StreamFeed, 'PAUSE', 0.05)
        feed = make(source=f'ws://127.0.0.1:{port}/')
        feed.start()
        deadline = time.monotonic() + 10
        while len(feed.messages) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
        feed.stop()
        server.shutdown()
    assert len(connections) >= 2
    feed.connected.set()
    feed.poll(dt.datetime(2026, 11, 12, 14, 1, tzinfo=UTC))
    values = [r[2] for r in rows(feed.dir / '2026-11-12' / 'h14-m0100.parquet')]
    assert values[:2] == [601.0, 602.0]


def test_feeds_come_from_every_folder_and_a_name_only_once(tmp_path):
    a, b, missing = tmp_path / 'a', tmp_path / 'b', tmp_path / 'missing'
    a.mkdir()
    b.mkdir()
    (a / 'flights.sql').write_text('SELECT 1')
    (b / 'readings.sql').write_text('SELECT 1')
    assert [p.name for p in recorder.feed_paths([a, b, missing])] == ['flights.sql', 'readings.sql']
    (b / 'flights.sql').write_text('SELECT 1')
    with pytest.raises(ValueError, match='two feeds named flights'):
        recorder.feed_paths([a, b])
