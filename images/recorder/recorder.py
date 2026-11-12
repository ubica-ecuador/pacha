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

A feed with `-- schedule: daily` is read a day at a time instead: see DailyFeed. One with
`-- schedule: listing` reads the files a web page lists, each once: see ListingFeed. One with
`-- schedule: stream` keeps what a websocket pushes: see StreamFeed.

The feeds are the .sql files of the folders RECORDER_FEEDS names, separated by colons
(a dashboards repository brings its own folder: see compose.dashboards.yaml).
"""
import datetime as dt
import http.client
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import duckdb
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect as websocket_connect

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


def header_list(sql, key):
    match = re.search(rf'^--\s*{key}:\s*(.+?)\s*$', sql, re.M)
    return match.group(1).split() if match else []


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
        # The order a closed hour is merged in, for a reader's pruning (`-- order: ...`).
        self.order = (re.search(r'^--\s*order:\s*(.+?)\s*$', self.sql, re.M) or [None, 'cell, hex, ts'])[1]
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
                    f"COPY (SELECT * FROM read_parquet([{listed}], union_by_name = true) ORDER BY {self.order}) TO '{tmp}' "
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


class ListingFeed(Feed):
    """A feed published as a stream of small zipped files that a web page lists (`-- schedule: listing`),
    as AEMO's NEMweb publishes the electricity market every five minutes.

    Its source is the page; `-- files:` is the pattern of the names on it. Every interval it reads the page and,
    oldest first, every file it has not read yet: downloads it, unzips its CSV, runs the feed's script with
    `source` set to it, and writes what comes out as a minute file of the hour its first row's `ts` falls in.
    Closed hours are merged, and the manifest is written, as for any feed. At start it reads what the page still
    lists within the retention, so a first start or a restart fills the history.

    A file that cannot be downloaded is tried again the next interval; one that cannot be read is skipped.
    """

    def __init__(self, sql_path, data, public_base, retention_days, source=None, interval=None, scratch=None):
        super().__init__(sql_path, data, public_base, retention_days, source=source, interval=interval)
        pattern = header(self.sql, 'files')
        if not pattern:
            raise ValueError(f'{sql_path}: a listing feed names its files (-- files: <pattern>)')
        self.pattern = re.compile(pattern)
        self.scratch = scratch or os.environ.get('RECORDER_SCRATCH') or tempfile.gettempdir()
        self.seen_file = self.dir / 'seen.json'
        self.seen = set(json.loads(self.seen_file.read_text())) if self.seen_file.exists() else set()

    def _get(self, url, into=None):
        if not re.match(r'^https?://', url):
            if into is None:
                return Path(url).read_bytes()
            return Path(url)
        request = urllib.request.Request(url, headers={'User-Agent': 'pacha-recorder'})
        with urllib.request.urlopen(request, timeout=60) as response:
            if into is None:
                return response.read()
            with open(into, 'wb') as out:
                shutil.copyfileobj(response, out, 1 << 20)
                expected = response.headers.get('Content-Length')
                if expected is not None and out.tell() != int(expected):
                    raise CutShort(f'download cut short: {out.tell()} of {expected} bytes')
            return into

    def _listed(self):
        page = self._get(self.source).decode('utf-8', 'replace')
        return sorted(set(self.pattern.findall(page)))

    def _read_file(self, name, now):
        """One listed file into a minute file; the rows written."""
        base = self.source if re.match(r'^https?://', self.source) else str(Path(self.source).parent) + '/'
        with tempfile.TemporaryDirectory(dir=self.scratch) as scratch:
            archive = self._get(base.rstrip('/') + '/' + name, Path(scratch) / 'file.zip')
            with zipfile.ZipFile(archive) as z:
                (member,) = [m for m in z.namelist() if m.lower().endswith('.csv')]
                csv = Path(scratch) / 'file.csv'
                with z.open(member) as src, open(csv, 'wb') as out:
                    shutil.copyfileobj(src, out, 1 << 20)
            self.db.execute('SET VARIABLE source = ?', [str(csv)])
            self.db.execute(f'CREATE OR REPLACE TEMP TABLE snap AS {self.sql}')
        rows, first = self.db.execute('SELECT count(*), min(ts) FROM snap').fetchone()
        if rows == 0:
            return 0
        first = first.astimezone(UTC)
        if first < now - self.retention:
            return 0
        path = self._day(first) / f'h{first:%H}-m{first:%M%S}.parquet'
        write_atomic(path, lambda tmp: self.db.execute(f"COPY snap TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)"))
        return rows

    def poll(self, now):
        self._delete_doomed()
        received = written = 0
        status, error_text = 'ok', None
        try:
            listed = self._listed()
            for name in listed:
                if name in self.seen:
                    continue
                try:
                    written += self._read_file(name, now)
                    received += 1
                    if received % 24 == 0:
                        # A first fill takes a while: what is read so far is readable as it goes.
                        self._write_manifest(now)
                except (duckdb.Error, ValueError, zipfile.BadZipFile) as error:
                    # The file, not the network: skipped for good.
                    log.error('%s: %s: %s', self.name, name, error)
                    status, error_text = 'error', f'{name}: {error}'
                self.seen.add(name)
            # The page lists a few days; what it no longer lists is not asked for again.
            self.seen &= set(listed)
            write_atomic(self.seen_file, lambda tmp: tmp.write_text(json.dumps(sorted(self.seen))))
        except duckdb.FatalException:
            raise
        except (urllib.error.URLError, http.client.HTTPException, CutShort, ConnectionError, TimeoutError) as error:
            # The network: what is left is read the next interval.
            log.error('%s: %s', self.name, error)
            status, error_text = 'unreachable', str(error)
        self._merge_closed_hours(now)
        self._log_poll(now, status, received, written, error_text)
        self._write_manifest(now)
        log.info('%s: %d files read, %d rows written', self.name, received, written)


class CutShort(OSError):
    """A download that ended before the length its server announced."""


class StreamFeed(Feed):
    """A feed a websocket pushes (`-- schedule: stream`): a message each time something changes, as a
    building's sensors send a reading when it moves.

    Its source is a ws:// or wss:// address. A thread holds the socket open and keeps each message as one line;
    when the socket drops it connects again, after a pause that doubles up to five minutes. Every interval the
    poll hands what came since the last one to the feed's script as newline-delimited JSON (`source`) and writes
    what the script returns as a minute file of the hour its `ts` falls in, so a message read just after the hour
    turns still lands in the hour it belongs to. Closed hours are merged, and the manifest is written, as for any
    feed. Nothing is dropped as already seen: a stream sends each message once.

    Messages of one stream need not share their keys: read them with read_ndjson_objects and ->>, so the
    script does not depend on which messages a poll happened to receive. A stream has no history: the recording
    starts when the recorder does.
    """
    PAUSE = 5  # seconds before connecting again; doubled after each failure
    MAX_PAUSE = 300
    STEADY = 60  # a connection that lasted this long resets the pause

    def __init__(self, sql_path, data, public_base, retention_days, source=None, interval=None,
                 health_file=None):
        super().__init__(sql_path, data, public_base, retention_days, source=source, interval=interval,
                         health_file=health_file)
        if not re.match(r'^wss?://', self.source or ''):
            raise ValueError(f'{sql_path}: a stream feed reads a ws:// or wss:// source')
        self.db.execute("SET TimeZone = 'UTC'")  # hours in UTC, as the files are named
        self.lock = threading.Lock()
        self.messages = []
        self.connected = threading.Event()
        self.stopped = threading.Event()
        self.socket = None

    # --- the socket ---

    def start(self):
        threading.Thread(target=self._listen, name=self.name, daemon=True).start()

    def stop(self):
        self.stopped.set()
        if self.socket is not None:
            self.socket.close()

    def receive(self, message):
        """One message, as the socket gave it."""
        if isinstance(message, bytes):
            message = message.decode('utf-8', 'replace')
        # JSON has no raw line break but as whitespace: joined, a message is one line.
        line = ' '.join(message.splitlines()).strip()
        if line:
            with self.lock:
                self.messages.append(line)

    def _listen(self):
        pause = self.PAUSE
        while not self.stopped.is_set():
            opened = time.monotonic()
            try:
                with websocket_connect(self.source, user_agent_header='pacha-recorder', open_timeout=30,
                                       max_size=1 << 22) as socket:
                    self.socket = socket
                    self.connected.set()
                    log.info('%s: connected to %s', self.name, self.source)
                    for message in socket:
                        self.receive(message)
                log.info('%s: the socket closed', self.name)
            except (OSError, TimeoutError, WebSocketException) as error:
                if not self.stopped.is_set():
                    log.error('%s: %s', self.name, error)
            self.socket = None
            self.connected.clear()
            if time.monotonic() - opened >= self.STEADY:
                pause = self.PAUSE
            self.stopped.wait(pause)
            pause = min(pause * 2, self.MAX_PAUSE)

    # --- one poll ---

    def poll(self, now):
        self._delete_doomed()
        with self.lock:
            messages, self.messages = self.messages, []
        received, written = len(messages), 0
        status, error_text = ('ok', None) if self.connected.is_set() else ('unreachable', 'not connected')
        try:
            if messages:
                with tempfile.TemporaryDirectory() as scratch:
                    path = Path(scratch) / 'messages.ndjson'
                    path.write_text('\n'.join(messages) + '\n')
                    self.db.execute('SET VARIABLE source = ?', [str(path)])
                    self.db.execute(f'CREATE OR REPLACE TEMP TABLE snap AS {self.sql}')
                # A clock ahead of ours is put in this hour; what is older than the retention, nowhere.
                self.db.execute(
                    "CREATE OR REPLACE TEMP TABLE fresh AS SELECT *, date_trunc('hour', least(ts, ?::TIMESTAMPTZ)) "
                    'AS _hour FROM snap WHERE ts >= ?::TIMESTAMPTZ', [now, now - self.retention])
                for (hour,) in self.db.execute('SELECT DISTINCT _hour FROM fresh ORDER BY 1').fetchall():
                    hour = hour.astimezone(UTC)
                    path = self._day(hour) / f'h{hour:%H}-m{now:%M%S}.parquet'
                    write_atomic(path, lambda tmp: self.db.execute(
                        f"COPY (SELECT * EXCLUDE (_hour) FROM fresh WHERE _hour = '{iso(hour)}'::TIMESTAMPTZ) "
                        f"TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)"))
                written = self.db.execute('SELECT count(*) FROM fresh').fetchone()[0]
            self._merge_closed_hours(now)
        except duckdb.FatalException:
            raise
        except (duckdb.Error, OSError) as error:
            log.error('%s: %s', self.name, error)
            status, error_text = 'error', str(error)
        self._log_poll(now, status, received, written, error_text)
        self._write_manifest(now)
        if status == 'ok' and self.health_file:
            self.health_file.touch()
        log.info('%s: %d messages, %d rows written', self.name, received, written)


class DailyFeed:
    """A feed published a day at a time, as one zipped CSV (`-- schedule: daily`).

    Its source names the day, as {day}: http://feeds/dma-ais/aisdk-{day}.zip.
    Every interval (an hour by default) it looks back for the days it does not
    have, newest first, and reads each one the source has: downloads it, unzips
    it, runs the feed's script with `source` (the CSV) and `day` set, and keeps
    every table named in `-- tables:` as <day>/<table>.parquet. A day is written
    under a .tmp directory and renamed whole, so a reader never sees half of it.

      YYYY-MM-DD/<table>.parquet   a day, one file per table
      manifest.json                every file, with its day and table
      polls.parquet                every day read: when, how it went, rows written

    It keeps the newest `retention_days` days the source published. A day that
    could not be downloaded is tried again the next interval; one that could
    not be read, a day later: a source of 650 MB a day is not fetched in a loop.
    """
    LOOK_BACK = 5  # days the source may publish late, beyond the ones kept

    def __init__(self, sql_path, data, public_base, retention_days, source=None, interval=None,
                 scratch=None):
        sql_path = Path(sql_path)
        self.name = sql_path.stem
        self.sql = sql_path.read_text()
        self.source = source or header(self.sql, 'source')
        self.interval = int(interval or header(self.sql, 'interval') or 3600)
        self.tables = header_list(self.sql, 'tables')
        if not self.tables:
            raise ValueError(f'{sql_path}: a daily feed names its tables (-- tables: ...)')
        self.retention = retention_days
        self.dir = Path(data) / self.name
        self.public = f'{public_base.rstrip("/")}/{self.name}'
        self.scratch = scratch or os.environ.get('RECORDER_SCRATCH') or tempfile.gettempdir()
        self.failed = {}  # day -> when it last failed
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o755)
        self.log_db = duckdb.connect()
        polls = self.dir / 'polls.parquet'
        if polls.exists():
            self.log_db.execute(f"CREATE TABLE polls AS SELECT * FROM read_parquet('{polls}')")
        else:
            self.log_db.execute('CREATE TABLE polls (ts TIMESTAMPTZ, day DATE, status VARCHAR, '
                                'written BIGINT, error VARCHAR)')

    def recover(self, now):
        """At start: drop a day a stop left half written."""
        for path in self.dir.iterdir():
            if path.is_dir() and path.name.endswith('.tmp'):
                shutil.rmtree(path)
        self._write_manifest()

    def poll(self, now):
        have = set(self._days())
        yesterday = now.date() - dt.timedelta(days=1)
        for back in range(self.retention + self.LOOK_BACK):
            day = yesterday - dt.timedelta(days=back)
            if day in have:
                continue
            if sum(1 for d in have if d > day) >= self.retention:
                break
            failed = self.failed.get(day)
            if failed and now - failed < dt.timedelta(days=1):
                continue
            if self._read_day(day, now):
                have.add(day)
                self._write_manifest()  # each day as soon as it is read: a first fill takes a while
        for day in sorted(have, reverse=True)[self.retention:]:
            shutil.rmtree(self.dir / day.isoformat(), ignore_errors=True)
        self._write_manifest()

    # --- one day ---

    def _fetch(self, day, into):
        """The day's CSV in `into`, or None when the source has not published it."""
        source = self.source.replace('{day}', day.isoformat())
        archive = Path(into) / 'day.zip'
        if re.match(r'^https?://', source):
            request = urllib.request.Request(source, headers={'User-Agent': 'pacha-recorder'})
            try:
                with urllib.request.urlopen(request, timeout=60) as response, open(archive, 'wb') as out:
                    shutil.copyfileobj(response, out, 1 << 20)
                    expected = response.headers.get('Content-Length')
                    if expected is not None and out.tell() != int(expected):
                        raise CutShort(f'download cut short: {out.tell()} of {expected} bytes')
            except urllib.error.HTTPError as error:
                if error.code in (403, 404):  # S3 says 403 for a key that is not there
                    return None
                raise
        elif os.path.exists(source):
            archive = Path(source)
        else:
            return None
        with zipfile.ZipFile(archive) as z:
            (member,) = [m for m in z.namelist() if m.lower().endswith('.csv')]
            csv = Path(into) / 'day.csv'
            with z.open(member) as src, open(csv, 'wb') as out:
                shutil.copyfileobj(src, out, 1 << 20)
        if archive.parent == Path(into):
            archive.unlink()
        return csv

    def _read_day(self, day, now):
        written = 0
        final = self.dir / day.isoformat()
        partial = self.dir / f'{day.isoformat()}.tmp'
        try:
            with tempfile.TemporaryDirectory(dir=self.scratch) as scratch:
                started = time.time()
                csv = self._fetch(day, scratch)
                if csv is None:
                    log.info('%s: %s not published yet', self.name, day)
                    return False
                db = self._connect(scratch)
                try:
                    db.execute('SET VARIABLE source = ?', [str(csv)])
                    db.execute('SET VARIABLE day = ?::DATE', [day])
                    db.execute(self.sql)
                    shutil.rmtree(partial, ignore_errors=True)
                    partial.mkdir()
                    for table in self.tables:
                        db.execute(f"COPY {table} TO '{partial / table}.parquet' "
                                   '(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)')
                        os.chmod(partial / f'{table}.parquet', 0o644)
                        written += db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                finally:
                    db.close()
            os.chmod(partial, 0o755)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(partial, final)
            self.failed.pop(day, None)
            self._log(now, day, 'ok', written, None)
            log.info('%s: %s read, %d rows in %.0f s', self.name, day, written, time.time() - started)
            return True
        except duckdb.FatalException:
            raise
        except (urllib.error.URLError, http.client.HTTPException, CutShort, ConnectionError, TimeoutError) as error:
            # The network, not the day: tried again the next interval.
            shutil.rmtree(partial, ignore_errors=True)
            log.error('%s: %s: %s', self.name, day, error)
            self._log(now, day, 'unreachable', 0, str(error))
            return False
        except (duckdb.Error, OSError, ValueError, zipfile.BadZipFile) as error:
            shutil.rmtree(partial, ignore_errors=True)
            self.failed[day] = now
            log.error('%s: %s: %s', self.name, day, error)
            self._log(now, day, 'error', 0, str(error))
            return False

    def _connect(self, scratch):
        config = {'autoinstall_known_extensions': 'false', 'temp_directory': scratch,
                  'preserve_insertion_order': 'false',
                  'memory_limit': os.environ.get('RECORDER_MEMORY_LIMIT', '2GB')}
        if os.environ.get('RECORDER_THREADS'):
            config['threads'] = int(os.environ['RECORDER_THREADS'])
        if os.path.isdir(EXTENSIONS):
            config['extension_directory'] = EXTENSIONS
        db = duckdb.connect(config=config)
        db.execute('LOAD h3')
        return db

    # --- files ---

    def _days(self):
        return sorted(dt.date.fromisoformat(p.name) for p in self.dir.iterdir()
                      if p.is_dir() and DAY_DIR.match(p.name))

    def _write_manifest(self):
        entries = [{'url': f'{self.public}/{day.isoformat()}/{table}.parquet', 'day': day.isoformat(),
                    'table': table}
                   for day in self._days() for table in self.tables
                   if (self.dir / day.isoformat() / f'{table}.parquet').exists()]
        write_atomic(self.dir / 'manifest.json', lambda tmp: tmp.write_text(json.dumps(entries)))

    def _log(self, now, day, status, written, error):
        self.log_db.execute('INSERT INTO polls VALUES (?, ?, ?, ?, ?)', [now, day, status, written, error])
        self.log_db.execute("DELETE FROM polls WHERE ts < ?::TIMESTAMPTZ - INTERVAL 30 DAY", [now])
        write_atomic(self.dir / 'polls.parquet', lambda tmp: self.log_db.execute(
            f"COPY polls TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)"))


def run_alone(feed):
    """A daily or listing feed's own loop, in its own thread: reading a day, or a first fill of a few days of
    files, takes minutes, and the feeds polled every minute must not wait for it."""
    try:
        while True:
            feed.poll(dt.datetime.now(UTC).replace(microsecond=0))
            time.sleep(feed.interval)
    except duckdb.FatalException as error:
        log.critical('%s: %s', feed.name, error)
        os._exit(1)  # the process restarts; DuckDB refuses every later statement


def feed_paths(folders):
    """The .sql files of every folder, by name; a folder that is not there has none. Two feeds of one name
    would write the same recordings: refused."""
    paths = sorted((p for folder in folders if folder.is_dir() for p in folder.glob('*.sql')), key=lambda p: p.name)
    names = [p.stem for p in paths]
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise ValueError(f'two feeds named {", ".join(twice)}: ' + ', '.join(str(p) for p in paths if p.stem in twice))
    return paths


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
    folders = [Path(f) for f in os.environ.get('RECORDER_FEEDS', '/etc/recorder/feeds').split(':') if f]
    data = Path(os.environ.get('RECORDER_DATA', '/var/lib/recorder'))
    public = os.environ.get('RECORDER_PUBLIC_BASE', 'http://feeds/recordings')
    retention = int(os.environ.get('RECORDER_RETENTION_DAYS', '7'))
    interval = os.environ.get('RECORDER_INTERVAL')
    health = os.environ.get('RECORDER_HEALTH_FILE', '/tmp/recorder-ok')
    try:
        paths = feed_paths(folders)
    except ValueError as error:
        sys.exit(str(error))
    feeds, alone, streams = [], [], []
    for path in paths:
        source = os.environ.get(f'RECORDER_SOURCE_{path.stem.upper().replace("-", "_")}')
        schedule = header(path.read_text(), 'schedule')
        if schedule == 'daily':
            alone.append(DailyFeed(path, data, public, retention, source=source))
        elif schedule == 'listing':
            alone.append(ListingFeed(path, data, public, retention, source=source))
        elif schedule == 'stream':
            streams.append(StreamFeed(path, data, public, retention, interval=interval, source=source,
                                      health_file=health))
        else:
            feeds.append(Feed(path, data, public, retention, interval=interval, source=source,
                              health_file=health))
    log.info('feeds: %s', ', '.join(f'{p.stem} ({p.parent})' for p in paths) or 'none')
    feeds += streams
    if not feeds and not alone:
        sys.exit(f'no feeds in {", ".join(str(f) for f in folders)}')
    now = dt.datetime.now(UTC)
    for feed in feeds + alone:
        feed.recover(now)
    for feed in alone:
        threading.Thread(target=run_alone, args=(feed,), name=feed.name, daemon=True).start()
    for feed in streams:
        feed.start()
    if not feeds:
        threading.Event().wait()
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
