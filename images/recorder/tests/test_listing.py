"""The listing recorder against a NEMweb-like page and zips built here: no network, no clock of its own."""
import datetime as dt
import json
import os
import zipfile
from pathlib import Path

import duckdb

import recorder

FEED_SQL = Path(os.environ.get('RECORDER_FEEDS', '/repo/recorder/feeds')) / 'aemo-scada.sql'
BASE = 'http://feeds/recordings'
UTC = dt.timezone.utc


def name(market):
    """A NEMweb file name for an interval ending at `market` (AEST)."""
    return f'PUBLIC_DISPATCHSCADA_{market:%Y%m%d%H%M}_0000000546{market:%H%M}01.zip'


def scada_zip(folder, market, units):
    """One dispatch interval as AEMO writes it: C line, I line, D lines, closing C line."""
    stamp = f'{market:%Y/%m/%d %H:%M:%S}'
    lines = ['C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,2026/11/05,10:30:14,0000000546757601,DISPATCHSCADA,0000000546757595',
             'I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED']
    lines += [f'D,DISPATCH,UNIT_SCADA,1,"{stamp}",{duid},{mw},"{stamp}"' for duid, mw in units]
    lines.append(f'C,"END OF REPORT",{len(lines) + 1}')
    path = folder / name(market)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(path.stem + '.CSV', '\r\n'.join(lines) + '\r\n')
    return path


def listing(folder, zips):
    """The page: each file named twice, in its link and its text, as NEMweb's directory pages do."""
    page = folder / 'index.html'
    page.write_text('<html><body><pre>' + ''.join(
        f'<a href="/Reports/Current/Dispatch_SCADA/{z.name}">{z.name}</a><br>' for z in zips) + '</pre></body></html>')
    return page


def feed(tmp_path, page):
    return recorder.ListingFeed(FEED_SQL, tmp_path / 'data', BASE, 7, source=str(page), scratch=str(tmp_path))


def rows(path):
    return duckdb.sql(f"SELECT duid, mw, ts FROM read_parquet('{path}') ORDER BY duid, ts").fetchall()


def test_reads_each_listed_file_once_into_the_utc_hour_of_its_interval(tmp_path):
    src = tmp_path / 'nemweb'
    src.mkdir()
    first = scada_zip(src, dt.datetime(2026, 11, 5, 10, 35), [('ER01', '274.89432'), ('ER02', '0')])
    second = scada_zip(src, dt.datetime(2026, 11, 5, 10, 40), [('ER01', '280.1'), ('ER02', '0')])
    page = listing(src, [first, second])
    f = feed(tmp_path, page)
    now = dt.datetime(2026, 11, 5, 0, 41, tzinfo=UTC)
    f.poll(now)
    day = tmp_path / 'data' / 'aemo-scada' / '2026-11-05'
    # 10:35 AEST is 00:35 UTC.
    assert sorted(p.name for p in day.iterdir()) == ['h00-m3500.parquet', 'h00-m4000.parquet']
    assert rows(day / 'h00-m3500.parquet') == [
        ('ER01', 274.89432, dt.datetime(2026, 11, 5, 0, 35, tzinfo=UTC)),
        ('ER02', 0.0, dt.datetime(2026, 11, 5, 0, 35, tzinfo=UTC)),
    ]
    assert json.loads((tmp_path / 'data' / 'aemo-scada' / 'seen.json').read_text()) == sorted([first.name, second.name])
    # Nothing new: nothing read again.
    f.poll(now + dt.timedelta(minutes=1))
    polls = duckdb.sql(f"SELECT status, received, written FROM read_parquet('{f.dir / 'polls.parquet'}') ORDER BY ts").fetchall()
    assert polls == [('ok', 2, 4), ('ok', 0, 0)]


def test_a_closed_hour_is_merged_by_unit_then_time_and_listed_in_the_manifest(tmp_path):
    src = tmp_path / 'nemweb'
    src.mkdir()
    zips = [scada_zip(src, dt.datetime(2026, 11, 5, 10, m), [('ER02', '1'), ('ER01', str(m))]) for m in (35, 40)]
    f = feed(tmp_path, listing(src, zips))
    f.poll(dt.datetime(2026, 11, 5, 0, 41, tzinfo=UTC))
    later = scada_zip(src, dt.datetime(2026, 11, 5, 11, 5), [('ER01', '300')])
    listing(src, zips + [later])
    f.poll(dt.datetime(2026, 11, 5, 1, 6, tzinfo=UTC))
    day = f.dir / '2026-11-05'
    assert sorted(p.name for p in day.iterdir() if p.suffix == '.parquet' and p not in f.doomed) == [
        'h00.parquet', 'h01-m0500.parquet']
    merged = duckdb.sql(f"SELECT duid, mw FROM read_parquet('{day / 'h00.parquet'}')").fetchall()
    assert merged == [('ER01', 35.0), ('ER01', 40.0), ('ER02', 1.0), ('ER02', 1.0)]
    manifest = json.loads((f.dir / 'manifest.json').read_text())
    assert [(e['url'], e['from']) for e in manifest] == [
        (f'{BASE}/aemo-scada/2026-11-05/h00.parquet', '2026-11-05T00:00:00Z'),
        (f'{BASE}/aemo-scada/2026-11-05/h01-m0500.parquet', '2026-11-05T01:00:00Z'),
    ]


def test_a_broken_file_is_skipped_for_good_and_the_rest_is_read(tmp_path):
    src = tmp_path / 'nemweb'
    src.mkdir()
    good = scada_zip(src, dt.datetime(2026, 11, 5, 10, 40), [('ER01', '1')])
    broken = src / name(dt.datetime(2026, 11, 5, 10, 35))
    broken.write_bytes(b'not a zip')
    f = feed(tmp_path, listing(src, [broken, good]))
    f.poll(dt.datetime(2026, 11, 5, 0, 41, tzinfo=UTC))
    assert sorted(p.name for p in (f.dir / '2026-11-05').iterdir()) == ['h00-m4000.parquet']
    assert broken.name in f.seen
    status, received = duckdb.sql(f"SELECT status, received FROM read_parquet('{f.dir / 'polls.parquet'}')").fetchone()
    assert (status, received) == ('error', 1)


def test_files_older_than_the_retention_are_not_kept(tmp_path):
    src = tmp_path / 'nemweb'
    src.mkdir()
    old = scada_zip(src, dt.datetime(2026, 10, 20, 10, 35), [('ER01', '1')])
    f = feed(tmp_path, listing(src, [old]))
    f.poll(dt.datetime(2026, 11, 5, 0, 41, tzinfo=UTC))
    assert not (f.dir / '2026-10-20').exists()
    assert old.name in f.seen
