"""Keeps what a live feed said, as Parquet that Grafana reads back over HTTP.

Each feed is a .sql file: a SELECT over read_json(getvariable('source')), with
its source and interval in header comments (`-- source: …`, `-- interval: …`).
Every interval the recorder runs it and writes what is new under
<data>/<feed>/:

  YYYY-MM-DD/hHH-mMMSS.parquet   one poll
  YYYY-MM-DD/hHH.parquet         a closed hour, merged, sorted for pruning
  manifest.json                  every file a reader should read, with its hour
  polls.parquet                  every poll: when, how it went, rows in and out

A reader only ever follows the manifest. Every file is written under a .tmp
name and renamed, and a file the manifest stops naming is deleted a poll later,
so a reader holding the previous manifest still finds what it names.
"""
import datetime as dt
import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import duckdb

log = logging.getLogger('recorder')
UTC = dt.timezone.utc
MINUTE_FILE = re.compile(r'^h(\d\d)-m(\d\d)(\d\d)\.parquet$')
HOUR_FILE = re.compile(r'^h(\d\d)\.parquet$')
# Plain dates, not day=…: DuckDB would read that as a hive partition and add a column.
DAY_DIR = re.compile(r'^(\d{4}-\d\d-\d\d)$')
EXTENSIONS = os.environ.get('RECORDER_EXTENSIONS', '/opt/recorder/extensions')


def header(sql, key):
    match = re.search(rf'^--\s*{key}:\s*(\S+)\s*$', sql, re.M)
    return match and match.group(1)


def iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def write_atomic(path, write):
    """write(tmp) fills a temporary file; it then replaces path in one step."""
    tmp = path.with_name(path.name + '.tmp')
    write(tmp)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


class Feed:
    def __init__(self, sql_path, data, public_base, retention_days, source=None, interval=None,
                 health_file=None):
        sql_path = Path(sql_path)
        self.name = sql_path.stem
        self.sql = sql_path.read_text()
        self.source = source or header(self.sql, 'source')
        self.interval = int(interval or header(self.sql, 'interval') or 60)
        self.retention = dt.timedelta(days=retention_days)
        self.dir = Path(data) / self.name
        self.public = f'{public_base.rstrip("/")}/{self.name}'
        self.health_file = Path(health_file) if health_file else None
        self.doomed = set()  # files the manifest no longer names, deleted on the next poll
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o755)

        config = {'autoinstall_known_extensions': 'false'}
        if os.path.isdir(EXTENSIONS):
            config['extension_directory'] = EXTENSIONS
        self.db = duckdb.connect(config=config)
        self.db.execute('LOAD h3; LOAD json')
        self.db.execute('CREATE TABLE last_seen (hex VARCHAR PRIMARY KEY, ts TIMESTAMPTZ)')
        polls = self.dir / 'polls.parquet'
        if polls.exists():
            self.db.execute(f"CREATE TABLE polls AS SELECT * FROM read_parquet('{polls}')")
        else:
            self.db.execute('CREATE TABLE polls (ts TIMESTAMPTZ, status VARCHAR, received INTEGER, '
                            'written INTEGER, error VARCHAR)')

    # --- one poll ---

    def _fetch(self, into):
        """The source as a local file. A URL is downloaded whole, in one GET: DuckDB's own
        HTTP reads cache a file by its URL, and a feed that changes size under that cache
        came back as malformed JSON, then as a fatal error."""
        if not re.match(r'^https?://', self.source):
            return self.source
        request = urllib.request.Request(self.source, headers={'User-Agent': 'pacha-recorder'})
        with urllib.request.urlopen(request, timeout=30) as response:
            path = Path(into) / 'snapshot.json'
            path.write_bytes(response.read())
        return str(path)

    def poll(self, now):
        self._delete_doomed()
        received = written = 0
        try:
            with tempfile.TemporaryDirectory() as scratch:
                self.db.execute('SET VARIABLE source = ?', [self._fetch(scratch)])
                self.db.execute(f'CREATE OR REPLACE TEMP TABLE snap AS {self.sql}')
            received = self.db.execute('SELECT count(*) FROM snap').fetchone()[0]
            self.db.execute('CREATE OR REPLACE TEMP TABLE fresh AS SELECT s.* FROM snap s '
                            'ANTI JOIN last_seen l ON s.hex = l.hex AND s.ts = l.ts')
            self.db.execute('INSERT OR REPLACE INTO last_seen SELECT hex, max(ts) FROM snap GROUP BY hex')
            # An aircraft not heard for an hour is gone; forget it.
            self.db.execute('DELETE FROM last_seen WHERE ts < ?::TIMESTAMPTZ - INTERVAL 1 HOUR', [now])
            written = self.db.execute('SELECT count(*) FROM fresh').fetchone()[0]
            if written:
                path = self._day(now) / f'h{now:%H}-m{now:%M%S}.parquet'
                write_atomic(path, lambda tmp: self.db.execute(
                    f"COPY fresh TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)"))
            self._merge_closed_hours(now)
            self._log_poll(now, 'ok', received, written, None)
            if self.health_file:
                self.health_file.touch()
            log.info('%s: %d received, %d written', self.name, received, written)
        except duckdb.FatalException:
            # DuckDB refuses every later statement: stop, and compose starts a new process.
            raise
        except (duckdb.Error, OSError) as error:
            log.error('%s: %s', self.name, error)
            self._log_poll(now, 'error', received, 0, str(error))
        self._write_manifest(now)

    def recover(self, now):
        """At start: merge the closed hours a stop left in minute files."""
        self._merge_closed_hours(now)
        self._write_manifest(now)
        self._delete_doomed()

    # --- files ---

    def _day(self, moment):
        path = self.dir / f'{moment:%Y-%m-%d}'
        if not path.exists():
            path.mkdir()
            os.chmod(path, 0o755)
        return path

    def _days(self):
        return sorted(p for p in self.dir.iterdir() if p.is_dir() and DAY_DIR.match(p.name))

    def _merge_closed_hours(self, now):
        current = (f'{now:%Y-%m-%d}', f'{now:%H}')
        for day in self._days():
            hours = {}
            for path in day.iterdir():
                match = MINUTE_FILE.match(path.name)
                if match and path not in self.doomed:
                    hours.setdefault(match.group(1), []).append(path)
            # union_by_name: an hour may hold files from before and after a column was added.
            for hour, minutes in sorted(hours.items()):
                if (day.name, hour) == current:
                    continue
                merged = day / f'h{hour}.parquet'
                inputs = sorted(minutes) + ([merged] if merged.exists() else [])
                listed = ', '.join(f"'{p}'" for p in inputs)
                write_atomic(merged, lambda tmp: self.db.execute(
                    f"COPY (SELECT * FROM read_parquet([{listed}], union_by_name = true) ORDER BY cell, hex, ts) TO '{tmp}' "
                    '(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)'))
                self.doomed.update(minutes)
                log.info('%s: merged %s/%s from %d files', self.name, day.name, hour, len(minutes))

    def _expired(self, day, now):
        return dt.date.fromisoformat(DAY_DIR.match(day.name).group(1)) < (now - self.retention).date()

    def _write_manifest(self, now):
        entries = []
        for day in self._days():
            if self._expired(day, now):
                self.doomed.add(day)
                continue
            date = DAY_DIR.match(day.name).group(1)
            for path in sorted(day.iterdir()):
                match = HOUR_FILE.match(path.name) or MINUTE_FILE.match(path.name)
                if not match or path in self.doomed:
                    continue
                start = dt.datetime.fromisoformat(f'{date}T{match.group(1)}:00:00+00:00')
                entries.append({'url': f'{self.public}/{day.name}/{path.name}',
                                'from': iso(start), 'to': iso(start + dt.timedelta(hours=1))})
        write_atomic(self.dir / 'manifest.json', lambda tmp: tmp.write_text(json.dumps(entries)))

    def _delete_doomed(self):
        for path in sorted(self.doomed, reverse=True):
            if path.is_dir():
                for child in path.iterdir():
                    child.unlink()
                path.rmdir()
            elif path.exists():
                path.unlink()
        self.doomed.clear()

    def _log_poll(self, now, status, received, written, error):
        self.db.execute('INSERT INTO polls VALUES (?, ?, ?, ?, ?)', [now, status, received, written, error])
        self.db.execute('DELETE FROM polls WHERE ts < ?::TIMESTAMPTZ - ?::INTERVAL',
                        [now, f'{self.retention.days} days'])
        write_atomic(self.dir / 'polls.parquet', lambda tmp: self.db.execute(
            f"COPY polls TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)"))


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
    feeds_dir = Path(os.environ.get('RECORDER_FEEDS', '/etc/recorder/feeds'))
    data = Path(os.environ.get('RECORDER_DATA', '/var/lib/recorder'))
    public = os.environ.get('RECORDER_PUBLIC_BASE', 'http://feeds/recordings')
    retention = int(os.environ.get('RECORDER_RETENTION_DAYS', '7'))
    interval = os.environ.get('RECORDER_INTERVAL')
    health = os.environ.get('RECORDER_HEALTH_FILE', '/tmp/recorder-ok')
    feeds = [Feed(path, data, public, retention, interval=interval,
                  source=os.environ.get(f'RECORDER_SOURCE_{path.stem.upper()}'), health_file=health)
             for path in sorted(feeds_dir.glob('*.sql'))]
    if not feeds:
        sys.exit(f'no feeds in {feeds_dir}')
    now = dt.datetime.now(UTC)
    for feed in feeds:
        feed.recover(now)
    # On the interval's boundaries, so a poll meets the gateway's cache once.
    step = min(feed.interval for feed in feeds)
    while True:
        time.sleep(step - time.time() % step)
        now = dt.datetime.now(UTC).replace(microsecond=0)
        for feed in feeds:
            if int(now.timestamp()) % feed.interval < step:
                feed.poll(now)


if __name__ == '__main__':
    main()
