# Flight recorder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worldwide live air traffic dashboard with a week of history that Pacha records itself.

**Architecture:** The gateway caches adsb.lol's whole-world snapshot for 60 s at `/adsblol/world`. A new `recorder` service (compose profile `recorder`) polls that same URL every 60 s and writes Parquet by day and hour, plus a `manifest.json`, to a `recordings` volume. The gateway serves that volume read-only at `/recordings/` on `feeds`, with a fallback manifest and an empty Parquet when nothing has been recorded. Grafana's DuckDB, which cannot read local files, reads the history over HTTP: a hidden variable lists the files for the time range, and the history panels pass that list to `read_parquet`.

**Tech Stack:** nginx 1.27 (gateway), Python 3.12 with the `duckdb` 1.5.4 wheel and the `h3` community extension (recorder), pytest, Grafana 13.2.1 with the DuckDB datasource (engine 1.5.4), Kepler panel, node:test.

**Spec:** `docs/superpowers/specs/2026-10-10-flight-recorder-design.md`

## Global Constraints

- Upstream: at most one request a minute to `api.adsb.lol`, from the gateway only. Nothing else in the stack calls adsb.lol directly.
- Retention: 7 days (`RECORDER_RETENTION_DAYS=7`). Interval: 60 s (`RECORDER_INTERVAL=60`). The gateway's cache TTL equals the interval.
- The recorder is off unless `COMPOSE_PROFILES` includes `recorder`. Without it, every dashboard panel still runs; history panels return no rows.
- Grafana's DuckDB init SQL stays as it is: `disabled_filesystems = 'LocalFileSystem'` is a security boundary. Never loosen it.
- Every file the recorder writes goes to a `.tmp` name first and is renamed. The gateway never serves `.tmp` names.
- All times are UTC. Partition names: `day=YYYY-MM-DD/hHH.parquet` (merged hour), `day=YYYY-MM-DD/hHH-mMMSS.parquet` (one poll).
- The recorder's DuckDB version equals the datasource's engine (`DUCKDB_ENGINE_VERSION` in `images/grafana/Dockerfile`, 1.5.4).
- Dashboards follow `dashboards/README.md`: canonical format, uid = file name, tags from the vocabulary.
- Docker access: Tasks 1, 2, 4, 5 and 6 need a session that can run `docker compose`. The session that wrote this plan could not; Task 3 can run with `docker build` only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Variable interpolation.** The whole history design rests on `${files:singlequote}` expanding to every manifest entry, in plain DuckDB panels and in Kepler datasets. Task 2 step 5 proves it before anything is built on it; if it fails, stop and switch to the spec's fallback (`SET VARIABLE` in the same query).
2. **Torn reads.** A reader must never see a half-written Parquet or a manifest naming a deleted file. Check the order in Task 3: write the new file, rename, rewrite the manifest, then delete what it replaced.
3. **The fallback path.** With the recorder off, `/recordings/flights/manifest.json` must come from the repo, and history panels must return zero rows, not errors. Task 4 step 4.
4. **Upstream rate.** With the dashboard open in several tabs and the recorder on, the gateway logs at most one adsb.lol fetch a minute. Task 6 step 2.

---

## File structure

| Path | Responsibility |
|---|---|
| `gateway/feeds.conf` | `/adsblol/world` (cached proxy), `/recordings/` (static, with fallback) |
| `gateway/recordings/flights/manifest.json` | Fallback manifest: the empty file only |
| `gateway/recordings/flights-empty.parquet` | The recorder's schema, no rows, < 2 KB |
| `images/recorder/Dockerfile` | Python 3.12 slim, duckdb 1.5.4, h3 extension, a `test` stage |
| `images/recorder/recorder.py` | Poll loop, dedupe, write, merge, retention, manifest, polls log, health marker |
| `images/recorder/tests/` | pytest, against fixture JSON, no network |
| `recorder/feeds/flights.sql` | The flights feed: source URL, interval, the `SELECT` |
| `recorder/make-empty.sh` | Regenerates `flights-empty.parquet` from `flights.sql` |
| `compose.yaml` | `recorder` service (profile), `recordings` volume, gateway mounts |
| `docker-bake.hcl` | `recorder` target |
| `.env.example`, `README.md` | How to turn the recorder on, what it costs |
| `dashboards/README.md` | Tag `aviation` |
| `dashboards/gallery/air-traffic-world.json` or `plus/dashboards/air-traffic-world.json` | The dashboard (folder decided in Task 2 step 5) |
| `tests/stack/feeds.test.mjs` | `/adsblol/world` |
| `tests/stack/flight-recorder.test.mjs` | Recordings over HTTP, with and without the profile |
| `tests/stack/air-traffic-world.test.mjs` | Every query of the dashboard runs |

---

### Task 1: The live feed through the gateway

**Files:**
- Modify: `gateway/feeds.conf`, `tests/stack/feeds.test.mjs`

**Interfaces:**
- Produces: `http://feeds/adsblol/world`, adsb.lol's `/v2/lat/0/lon/0/dist/20000`, plain JSON to a client that does not ask for gzip, cached 60 s.

- [ ] **Step 1: Add the cache zone and the location**

In the header comment, a paragraph like the others: adsb.lol, the whole world in one request (about 6,000 aircraft, 3.6 MB plain, 850 KB gzipped), a community service with no key, one fetch a minute shared by the live panels and the recorder.

```nginx
proxy_cache_path /var/cache/nginx/adsblol levels=1:2 keys_zone=adsblol:10m
                 max_size=100m inactive=1h use_temp_path=off;
```

Inside `server { server_name feeds; … }`:

```nginx
    # adsb.lol: every aircraft in the world, one request. Asked for gzip and
    # stored that way (850 KB against 3.6 MB). One fetch a minute, whoever
    # asks: the live panels and the recorder share this copy.
    location = /adsblol/world {
        set $adsblol api.adsb.lol;
        proxy_pass https://$adsblol/v2/lat/0/lon/0/dist/20000;
        proxy_set_header Host $adsblol;
        proxy_set_header User-Agent 'Pacha (+https://github.com/ubica-ecuador/pacha)';
        proxy_set_header Accept-Encoding gzip;
        proxy_ssl_server_name on;
        gunzip on;
        proxy_cache adsblol;
        proxy_cache_key $uri;
        proxy_cache_valid 200 60s;
        add_header X-Cache-Status $upstream_cache_status always;
    }
```

Copy `proxy_ssl_server_name`, timeouts and anything else from the TriMet location if it sets them; match it, do not invent.

- [ ] **Step 2: Test**

Append to `tests/stack/feeds.test.mjs`:

```js
const WORLD = '/adsblol/world';

test('DuckDB reads every aircraft in the world through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `SELECT len(ac) AS n FROM read_json('http://feeds${WORLD}', columns = {ac: 'JSON[]'})`);
  assert.ok(Number(row.n) > 1000, `only ${row.n} aircraft`);
});

test('adsb.lol is asked once a minute at most', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${WORLD}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});
```

- [ ] **Step 3: Run**

`docker compose up -d gateway && node --test tests/stack/feeds.test.mjs`. Expected: all pass. Also time a cold read, to check the spec's open question about the 60 s timeout:

```sql
SELECT count(*) FROM (SELECT unnest(ac) FROM read_json('http://feeds/adsblol/world', columns = {ac: 'JSON[]'}))
```

Record the time in the commit message. Over 10 s: stop and tell the user.

- [ ] **Step 4: Commit** — `feat: adsb.lol's whole world through the gateway`

---

### Task 2: Recordings over HTTP, and proof that a file list interpolates

**Files:**
- Create: `recorder/feeds/flights.sql`, `recorder/make-empty.sh`, `gateway/recordings/flights/manifest.json`, `gateway/recordings/flights-empty.parquet`
- Modify: `gateway/feeds.conf`, `compose.yaml`

**Interfaces:**
- Produces: `flights.sql`, the schema contract for Tasks 3 to 5. `http://feeds/recordings/…`, which serves the `recordings` volume and falls back to `gateway/recordings/`.

- [ ] **Step 1: Write `recorder/feeds/flights.sql`**

Header comments are the recorder's configuration. The source is read through `getvariable('source')` so tests can point it at a fixture file. Columns and types exactly as in the spec's table:

```sql
-- source: http://feeds/adsblol/world
-- interval: 60
WITH snap AS (
  SELECT make_timestamptz((now * 1000)::BIGINT) AS polled, unnest(ac) AS a
  FROM read_json(getvariable('source'), columns = {now: 'DOUBLE', ac: 'JSON[]'})
)
SELECT
  polled - to_milliseconds((coalesce((a->>'seen_pos')::DOUBLE, 0) * 1000)::BIGINT) AS ts,
  a->>'hex' AS hex,
  nullif(trim(a->>'flight'), '') AS flight,
  a->>'r' AS reg,
  a->>'t' AS type,
  a->>'category' AS category,
  a->>'type' AS source,
  (a->>'lat')::DOUBLE AS lat,
  (a->>'lon')::DOUBLE AS lon,
  h3_latlng_to_cell((a->>'lat')::DOUBLE, (a->>'lon')::DOUBLE, 4) AS cell,
  try_cast(a->>'alt_baro' AS INTEGER) AS alt_baro,
  coalesce(a->>'alt_baro' = 'ground', false) AS on_ground,
  try_cast(a->>'alt_geom' AS INTEGER) AS alt_geom,
  try_cast(a->>'baro_rate' AS INTEGER) AS baro_rate,
  (a->>'gs')::DOUBLE AS gs,
  (a->>'track')::DOUBLE AS track,
  a->>'squawk' AS squawk,
  a->>'emergency' AS emergency
FROM snap
WHERE a->>'lat' IS NOT NULL
```

Check every expression against the sample in the scratchpad (`g.json`, adsb.lol's real answer) with the DuckDB 1.5.4 CLI before going on: `now` is milliseconds, `seen_pos` seconds, `alt_baro` a number or `"ground"`. Check `h3_latlng_to_cell`'s return type: the spec says UBIGINT; if it is BIGINT, keep BIGINT and fix the spec's table.

- [ ] **Step 2: `recorder/make-empty.sh` and the empty file**

A script that runs `flights.sql` against an empty fixture (`{"now": 0, "ac": []}`) with the DuckDB CLI of the pinned version and writes `gateway/recordings/flights-empty.parquet` (`COMPRESSION zstd`). Run it. Expected: a file under 2 KB with 18 columns and 0 rows.

- [ ] **Step 3: The fallback manifest**

`gateway/recordings/flights/manifest.json`:

```json
[{"url": "http://feeds/recordings/flights-empty.parquet", "from": "1970-01-01T00:00:00Z", "to": "9999-12-31T00:00:00Z"}]
```

Entries have this shape in the real manifest too (Task 3).

- [ ] **Step 4: Serve `/recordings/`**

`compose.yaml`, gateway volumes:

```yaml
      # What the recorder writes, read-only. Grafana's DuckDB cannot read local
      # files, so it reads them here, over HTTP.
      - recordings:/srv/recordings:ro
      # Served when the recorder has written nothing: an empty recording.
      - ./gateway/recordings:/srv/fallback/recordings:ro
```

and `recordings: {}` under `volumes:`.

`gateway/feeds.conf`, inside the `feeds` server:

```nginx
    # The recorder's Parquet and manifest (compose profile `recorder`). Static,
    # by ranges, never cached: the manifest changes every minute. Without a
    # recording, the repo's fallback: a manifest naming one empty file.
    location /recordings/ {
        root /srv;
        add_header Cache-Control no-cache always;
        location ~ \.tmp$ { return 404; }
        try_files $uri /fallback$uri =404;
    }
    location /fallback/ {
        internal;
        root /srv;
        add_header Cache-Control no-cache always;
    }
```

Then `docker compose up -d gateway` and from the grafana container: `curl -s http://feeds/recordings/flights/manifest.json` (the fallback), `curl -sI -r 0-3 http://feeds/recordings/flights-empty.parquet` (206).

- [ ] **Step 5: Prove the interpolation (spike, gate for everything after)**

On the running stack, in a scratch dashboard (never saved to the repo), with the recordings served by hand: copy a few hours of real Parquet into the volume (`docker compose cp`, or `docker run --rm -v pacha_recordings:/r …`) and a manifest naming them. Then:

1. Variable `files`, DuckDB datasource, hidden, multi-value, include All, no custom all value, refresh on time range change, the query from the spec (`… WHERE "to" >= $__timeFrom() AND "from" <= $__timeTo() UNION ALL SELECT 'http://feeds/recordings/flights-empty.parquet'`). Check the macros' syntax in the DuckDB datasource; adjust the query, not the design.
2. A table panel: `SELECT count(*) FROM read_parquet([${files:singlequote}]) WHERE ts BETWEEN $__timeFrom() AND $__timeTo()`. Change the time range; the query inspector shows the list changing.
3. A Kepler panel (free) and a Kepler Plus panel, each with a dataset using the same `read_parquet([${files:singlequote}])`. Does the dataset SQL get variables interpolated? Does the free panel have a trip layer, and picking that sets a variable?
4. Range with no recording: zero rows, no error.

Record the answers for the user. Decide the folder: Gallery if the free panel does 3 (trip layer, picking); Plus otherwise. If 1 or 2 fail, stop: the spec's fallback needs the user's decision.

- [ ] **Step 6: Commit** — `feat: recordings served by the gateway, with an empty fallback` (not the scratch dashboard).

---

### Task 3: The recorder

**Files:**
- Create: `images/recorder/Dockerfile`, `images/recorder/recorder.py`, `images/recorder/tests/test_recorder.py`, `images/recorder/tests/fixtures/*.json`
- Modify: `docker-bake.hcl`

**Interfaces:**
- Consumes: `recorder/feeds/*.sql` (mounted at `/etc/recorder/feeds`), `http://feeds/adsblol/world`.
- Produces: under `/var/lib/recorder/<feed>/` the partitions, `manifest.json`, `polls.parquet`; `/tmp/recorder-ok` touched after every successful poll.

- [ ] **Step 1: Dockerfile**

```dockerfile
# The recorder: keeps what a live feed said, as Parquet. Its DuckDB is the
# grafana datasource's engine, so the files it writes are the files Grafana reads.
ARG DUCKDB_VERSION=1.5.4
FROM python:3.12-slim AS base
ARG DUCKDB_VERSION
RUN pip install --no-cache-dir "duckdb==${DUCKDB_VERSION}" \
 && python -c "import duckdb; c = duckdb.connect(); c.sql('INSTALL h3 FROM community; INSTALL json; INSTALL httpfs')"
WORKDIR /app
COPY recorder.py .

FROM base AS test
RUN pip install --no-cache-dir pytest
COPY tests tests
RUN python -m pytest -q tests

FROM base
USER nobody
HEALTHCHECK … (see step 4)
ENTRYPOINT ["python", "recorder.py"]
```

Extensions installed as root land in root's home: set `HOME` or `extension_directory` to a path `nobody` can read, as the grafana image does (`/opt/pacha/duckdb-home`). Pin pytest.

- [ ] **Step 2: Write the tests first**

`images/recorder/tests/test_recorder.py`, each with a temp dir as the data root and fixture snapshots as the source. Fixtures: three snapshots cut down from the real answer (`g.json`, 5 aircraft each): `t0`, `t1` (one aircraft moved, one unchanged with the same `seen_pos` reference, one landed with `alt_baro: "ground"`), `t2` in the next hour.

- `poll` writes `day=…/hHH-mMMSS.parquet` with the spec's 18 columns and types.
- An aircraft whose `ts` did not change since the previous poll is not written twice.
- `alt_baro: "ground"` gives `alt_baro` null and `on_ground` true.
- A poll in a new hour merges the previous hour's minute files into `hHH.parquet`, sorted by `cell, hex, ts`, zstd, and deletes them; row count preserved.
- At start, minute files of a closed hour left over by a crash are merged.
- Days older than the retention are deleted; today and the 7 days before stay.
- `manifest.json` lists exactly the `.parquet` files present, each with its `from`/`to`, URLs under the configured base; never a `.tmp`.
- A failing source (fixture path that does not exist) writes a poll with an error to `polls.parquet`, writes no data file, and does not touch `/tmp/recorder-ok`.
- No file anywhere is left with a `.tmp` name after any of the above.

Run `docker build --target test images/recorder`. Expected: the tests fail (no recorder yet).

- [ ] **Step 3: Implement `recorder.py`**

One process, one feed per `.sql` in `/etc/recorder/feeds`, one in-memory DuckDB connection per feed (it holds `last_seen(hex, ts)` across polls). Configuration from the environment: `RECORDER_INTERVAL` (overrides the header), `RECORDER_RETENTION_DAYS`, `RECORDER_DATA` (`/var/lib/recorder`), `RECORDER_PUBLIC_BASE` (`http://feeds/recordings`), `RECORDER_SOURCE_<FEED>` (overrides the header's source; the tests use it).

Per poll, in this order:
1. `SET VARIABLE source = …`; run the feed's SQL into a temp table `snap`.
2. Drop rows whose `(hex, ts)` equals `last_seen`; upsert `last_seen`.
3. `COPY` what remains to `hHH-mMMSS.parquet.tmp` (`FORMAT parquet, COMPRESSION zstd`), `os.replace` to the final name. Zero rows: no file.
4. If the hour of this poll differs from the hour of the newest minute file: merge every closed hour (`ORDER BY cell, hex, ts`, `ROW_GROUP_SIZE 122880`), `.tmp` then rename, rewrite the manifest, then delete the minute files.
5. Retention: delete `day=` directories older than `today - RECORDER_RETENTION_DAYS`, after the manifest no longer names them.
6. Rewrite the manifest, `.tmp` then rename. `from`/`to` come from the file name: the hour's bounds, for merged and minute files alike.
7. Append the poll (`ts`, `status`, `received`, `written`, `error`) to the polls table; keep the retention's worth; rewrite `polls.parquet` (`.tmp`, rename).
8. On success, touch `/tmp/recorder-ok`.

Sleep to the next multiple of the interval, so polls land on the minute and meet the gateway's cache once. An exception in one poll is logged and recorded in the polls log; the loop goes on. Files `0644`, directories `0755`.

Run the tests until they pass.

- [ ] **Step 4: Health**

`HEALTHCHECK CMD find /tmp/recorder-ok -mmin -3 | grep -q .` (three intervals at 60 s). In compose (Task 4), override with the same and `start_period: 90s`.

- [ ] **Step 5: Bake target**

`docker-bake.hcl`: target `recorder` like `titiler`, context `images/recorder`, added to the default group.

- [ ] **Step 6: Commit** — `feat: the recorder, which keeps a live feed as Parquet`

---

### Task 4: The recorder in the stack

**Files:**
- Modify: `compose.yaml`, `.env.example`, `README.md`
- Create: `tests/stack/flight-recorder.test.mjs`

- [ ] **Step 1: The service**

```yaml
  # Keeps what a live feed said, as Parquet, for the history panels: one
  # request a minute, around the clock, so it runs only when asked for
  # (COMPOSE_PROFILES=recorder). See recorder/feeds/.
  recorder:
    profiles: [recorder]
    build: images/recorder
    image: ghcr.io/ubica-ecuador/pacha-recorder:${STACK_VERSION:-dev}
    environment:
      RECORDER_INTERVAL: ${RECORDER_INTERVAL:-60}
      RECORDER_RETENTION_DAYS: ${RECORDER_RETENTION_DAYS:-7}
    volumes:
      - ./recorder/feeds:/etc/recorder/feeds:ro
      - recordings:/var/lib/recorder
    networks:
      default:
        aliases: [pacha-recorder]
    depends_on:
      gateway:
        condition: service_healthy
    healthcheck: …
```

The volume must be writable by `nobody`: either create the directories in the image with that owner (a fresh named volume copies the mount point's ownership), or run as a fixed uid that owns `/var/lib/recorder` in the image. Check on a fresh volume.

- [ ] **Step 2: `.env.example` and README**

`.env.example`: a block like FRED's: `# COMPOSE_PROFILES=recorder`, `# RECORDER_INTERVAL=60`, `# RECORDER_RETENTION_DAYS=7`, what it costs (one request a minute to adsb.lol, 400 to 650 MB a day of disk at most, a week kept). README: one paragraph where the other optional pieces are described.

- [ ] **Step 3: Stack test**

`tests/stack/flight-recorder.test.mjs`. Skip the recorder half when `docker compose ps recorder` shows it is not running (`'the recorder profile is off'`), as the Plus tests skip without Plus.

- Always: `http://feeds/recordings/flights/manifest.json` parses, every URL in it is readable by DuckDB in grafana, and `flights-empty.parquet` has the same columns and types as one poll of `flights.sql` (`DESCRIBE` both).
- Always: `http://feeds/recordings/x.parquet.tmp` answers 404.
- Recorder on: within 150 s (`waitFor`), the manifest names a minute file of the current hour; `SELECT count(*), count(DISTINCT hex) FROM read_parquet([…])` over it is > 1000 rows.

- [ ] **Step 4: Run both ways**

`docker compose up -d --wait && node --test tests/stack/flight-recorder.test.mjs`: recorder half skipped, rest pass. Then `COMPOSE_PROFILES=recorder docker compose up -d --wait` and again: all pass. `docker compose logs recorder` shows one poll a minute, no errors.

- [ ] **Step 5: Commit** — `feat: the recorder joins the stack, behind a profile`

---

### Task 5: The dashboard

Let the recorder run for at least two hours before this task, so there are merged hours to look at.

**Files:**
- Create: the dashboard JSON (folder from Task 2 step 5), `tests/stack/air-traffic-world.test.mjs`
- Modify: `dashboards/README.md` (tag `aviation`)

- [ ] **Step 1: Build it in Grafana**

Title `Air traffic, worldwide`, uid `air-traffic-world`, refresh 60 s, default range last 6 hours. Tags: `duckdb`, `kepler` (or `plus` and the Plus ones), `live`, `aviation`. Description: what it shows, that the live part is adsb.lol (ODbL) and the history is what this instance recorded, that coverage is dense in Europe and North America and thin elsewhere, and that history needs the `recorder` profile.

Variables: `files` (Task 2 step 5, hidden), `hex` (picked aircraft, text or from picking, empty by default).

Rows and panels, per the spec:
1. **Live**: Kepler map of `/adsblol/world` (points by `alt_baro`, rotated by `track`, ground traffic dimmed); stats: aircraft now, on the ground, emergency squawks.
2. **History**: Kepler H3 density of the range (`cell` at res 4, `h3_cell_to_parent` to 3 above a day's range); time series of distinct aircraft per hour, with hours missing from `polls.parquet` as nulls; tables of top airlines (`left(flight, 3)` where it is three letters) and types.
3. **Tracks**: trip layer for `$hex` (or the drawn area through `areaFilter`), capped at 50,000 points; altitude and ground speed of `$hex` over the range.

Every history query: `FROM read_parquet([${files:singlequote}]) WHERE ts BETWEEN $__timeFrom() AND $__timeTo()`. Save; Git Sync writes the file.

- [ ] **Step 2: Conventions and README**

Tag `aviation` in `dashboards/README.md`'s theme list, same commit. Check the file is canonical (Grafana wrote it).

- [ ] **Step 3: Test**

`tests/stack/air-traffic-world.test.mjs`, after the shipping one: follows the conventions; every DuckDB query (panels and Kepler datasets) runs through `duckdb()` with `${files:singlequote}` replaced by the current manifest's URLs and the time macros by a fixed recent range; with the fallback manifest, every history query returns zero rows and no error. Browser checks only if the shipping test has them for the same panel type.

- [ ] **Step 4: Commit** — `feat: air traffic worldwide, live and recorded`

---

### Task 6: Regression and the numbers

- [ ] **Step 1: Suites** — `npm test` with the recorder on. Expected: all pass, except what is already skipped for missing keys or Plus.
- [ ] **Step 2: Upstream rate** — the dashboard open in three tabs for five minutes, recorder on. In `docker compose logs gateway`, count requests to `/adsblol/world` with `X-Cache-Status` MISS or EXPIRED: at most one a minute.
- [ ] **Step 3: A day's size** — after 24 h of recording: `du -sh` of one `day=` directory, and its row count. Put both in the spec, replacing the estimate; mark the spec `implemented`.
- [ ] **Step 4: Commit** — `docs: the flight recorder's real numbers`
