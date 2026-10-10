# Flight recorder: live air traffic and a week of history

Date: 2026-10-10
Status: draft

## Problem

Pacha's live dashboards (TriMet, MBTA) show the present only: a feed that
reloads by itself has no past. Public flight archives exist, but they are
either too coarse (OpenSky's monthly flight lists on Zenodo, which end in
2022) or too heavy (adsb.lol's daily globe history, about 4 GB a day). What
the stack lacks is a way to keep what a live feed said, so a dashboard can
replay it over Grafana's time range.

## Goals

1. A dashboard with every aircraft in the world, live, and the last seven
   days of their positions, queried by Grafana's time range.
2. A recorder service that keeps a live feed as Parquet, generic enough that
   recording another feed (TriMet, MBTA) is one SQL file.
3. One request a minute to adsb.lol, whatever the audience and whether or not
   the recorder runs.

## Non-goals

- Public historical archives (OpenSky on Zenodo, adsb.lol globe history).
- Recording any feed other than flights. The recorder is generic; the other
  feeds are later work.
- The deferred `/geo/` API service. The recorder exposes no HTTP at all.
- Airports, routes or schedules: positions only.

## What the probes established

Tried on 2026-10-10 around 05:20 UTC:

- `api.adsb.lol/v2/lat/0/lon/0/dist/20000` answers with the whole world:
  6,199 aircraft, latitudes -46 to 70, 3.6 MB plain and 850 KB gzipped. No
  key, no published rate limit, ODbL. `/v2/all` answers 503 and `re-api` 403.
- OpenSky's `/states/all` returns 6,567 aircraft, but costs 4 credits of the
  400 a day an anonymous client gets: about 100 polls a day. Not enough.
- airplanes.live answers 403.
- Coverage is uneven: Europe and the US are dense, South America and Africa
  have gaps (one aircraft within 250 NM of Cuenca).

Then, with the DuckDB 1.5.4 CLI (the datasource's engine) and the
datasource's own init settings (`allow_persistent_secrets = false`,
`enable_external_file_cache = false`, `disabled_filesystems =
'LocalFileSystem'`), against Parquet served over HTTP with range requests:

- Grafana's DuckDB cannot read local files, so a volume mounted in the
  grafana container is useless: recordings must be read over HTTP.
- Over HTTP there is no glob. `read_parquet` takes a list, but not from a
  subquery ("Table function cannot contain subqueries").
- A list from a manifest works through `SET VARIABLE … ; read_parquet(
  getvariable(…))`, and so does `ATTACH` of a `.duckdb` catalog over HTTP
  whose views name the files. Both need two statements in one query, which no
  Pacha dashboard does yet.
- A plain `read_parquet(['http://…', …])` with a literal list works, in one
  statement.

## Design

```
api.adsb.lol ──► gateway  /adsblol/world   (cache 55 s, lock on)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
   live panels            recorder (profile `recorder`)
   (DuckDB, 60 s)              │  polls the same URL every 60 s
                               ▼
                    volume `recordings`: Parquet by day and hour,
                               │          plus manifest.json
                               │  mounted read-only in the gateway
                               ▼
                 gateway  /recordings/…  (feeds only, static, no cache)
                               │
                               ▼
   hidden variable `files` ◄── manifest.json, by time range
   read_parquet([${files:singlequote}])
```

The recorder reads through the gateway, not from adsb.lol: live panels and
the recorder share one cached copy, so upstream sees at most one request a
minute. Grafana reads the recordings back through the gateway too, since its
DuckDB cannot touch local files.

### Gateway

`location = /adsblol/world` in `gateway/feeds.conf`, no parameters:

- `proxy_pass` to `/v2/lat/0/lon/0/dist/20000`, asked for gzip and stored
  that way, `gunzip on` for clients that do not ask (as TriMet).
- `proxy_cache_valid 200 55s`, `proxy_cache_lock on`, key `$uri`. Not 60 s:
  the recorder polls on the minute, and the copy its previous poll fetched,
  stored a second or so after that minute, would still be fresh. At 60 s every
  other poll got the same snapshot again (seen on the running stack).
- A `User-Agent` naming Pacha and its repo URL.
- Room for a key through envsubst, like FRED, should adsb.lol start asking
  for one. Not set today.

### Recorder

A new image, `images/recorder`: Python with the `duckdb` package and the `h3`
extension installed at build. Service `recorder` in `compose.yaml` under the
compose profile `recorder`, alias `pacha-recorder`, no ports.

Off by default: a public instance does not poll adsb.lol around the clock
unless someone turns it on. Without it the live panels work and the history
panels say there is no recording.

**Feeds as SQL.** Each feed is `recorder/feeds/<name>.sql`, a `SELECT` over
`read_json(getvariable('source'))`, with its source URL and interval in header
comments. The recorder downloads the source itself, whole, in one GET, and
hands DuckDB the local file: DuckDB's own HTTP reads cache a file by its URL,
and a feed that changed size under that cache came back as malformed JSON a
poll in four, then as a fatal error that stopped the process. Only
`flights.sql` exists. Its columns:

| column       | type        | from                                        |
|--------------|-------------|---------------------------------------------|
| `ts`         | TIMESTAMPTZ | `now - seen_pos`: when the position was heard |
| `hex`        | VARCHAR     | `hex` (ICAO 24-bit address)                 |
| `flight`     | VARCHAR     | `trim(flight)`                              |
| `reg`, `type`| VARCHAR     | `r`, `t`                                    |
| `category`   | VARCHAR     | `category`                                  |
| `source`     | VARCHAR     | `type` (adsb_icao, mlat, tisb_…)            |
| `lat`, `lon` | DOUBLE      |                                             |
| `cell`       | UBIGINT     | H3 resolution 4 of the position             |
| `alt_baro`   | INTEGER     | null when `"ground"`                        |
| `on_ground`  | BOOLEAN     | `alt_baro = 'ground'`                       |
| `alt_geom`, `baro_rate` | INTEGER |                                    |
| `gs`, `track`| DOUBLE      |                                             |
| `squawk`, `emergency` | VARCHAR |                                      |

Rows without a position are dropped.

**Dedupe.** The recorder keeps the last `ts` per `hex` in memory and drops a
row whose position has not changed since the previous poll. After a restart
the first poll may repeat one row per aircraft; harmless.

**Writing.** Two levels, every write to a `.tmp` name and then renamed, so a
reader never sees half a file. Days are plain dates, not `day=…`: DuckDB reads
`day=` in a path as a hive partition and adds a `day` column, which made a
merged hour one column wider than its minutes.

- Every minute: `flights/2026-10-10/h14-m0315.parquet`.
- When the hour closes: the minute files merge into
  `flights/2026-10-10/h14.parquet`, zstd, sorted by `cell, hex, ts`. The
  manifest stops naming the minute files at once; they are deleted on the
  next poll, so a reader holding the previous manifest still finds them. Sorted by cell, the row-group statistics let DuckDB skip what is
  outside a drawn area; by `ts` within, what is outside the time range.
- On start, any closed hour still in minute files is merged first.

**Manifest.** After every write, merge or deletion, the recorder rewrites
`flights/manifest.json` (through a `.tmp` and a rename): one entry per file,
`{"url", "from", "to"}`, the URL as Grafana reaches it
(`http://feeds/recordings/flights/…`) and the time span its rows cover.

**Polls log.** `flights/polls.parquet`, rewritten every poll: `ts`, status,
rows received, rows written, error. It tells "no traffic" from "no recording", and backs
the healthcheck.

**Retention.** `RECORDER_RETENTION_DAYS=7`: older day directories leave the
manifest, then are deleted on the next poll.

**Health.** Healthy when the last successful poll is under three intervals
old. A fatal DuckDB error ends the process, and compose restarts it
(`restart: unless-stopped`).

**Configuration** (`.env.example`): `COMPOSE_PROFILES=recorder` to turn it
on, `RECORDER_INTERVAL=60`, `RECORDER_RETENTION_DAYS=7`.

### Volume

At 6,000 to 10,000 aircraft a minute: 10 to 14 million rows a day. One real
poll (6,199 aircraft, `flights.sql` as written below) is 276 KB of zstd
Parquet on its own, so a day of minute files would be 400 to 650 MB; merged
hours, sorted, should compress better. Budget 3 to 4.5 GB for the week until
a real day is measured, before the spec is marked implemented.

The `recordings` volume is mounted read-write in `recorder` and read-only in
`gateway`. Files are written world-readable; nginx runs as another uid.

### Reading the recordings

`location /recordings/` on the `feeds` server only: static files from the
volume, range requests (nginx's own), `Cache-Control: no-cache`, no proxy
cache, `.tmp` names refused. When the volume holds no manifest (recorder never
ran) the gateway answers with a fallback manifest naming one file only,
`gateway/recordings/flights-empty.parquet`: committed, under 2 KB, the
recorder's schema with no rows. A test keeps its schema equal to
`flights.sql`'s.

A history panel reads in one statement:

```sql
SELECT … FROM read_parquet([${files:singlequote}])
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
```

`files` is a hidden query variable on the DuckDB datasource, multi-value,
`All` selected, refreshed on time range change:

```sql
SELECT url FROM read_json('http://feeds/recordings/flights/manifest.json',
  columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})
WHERE "to" >= $__timeFrom() AND "from" <= $__timeTo()
UNION ALL SELECT 'http://feeds/recordings/flights-empty.parquet'
```

The columns are explicit because a recorder that has just started writes
`[]`, from which DuckDB detects no columns at all. The empty file is always in
the list, so a range with no recording returns no
rows instead of failing. A week is at most 168 hourly files and 60 minute
files: a query of about 20 KB.

If one-statement interpolation proves fragile, the fallback is the manifest
read with `SET VARIABLE` in the same query, which needs the datasource to run
two statements: verify first.

### Dashboard: Air traffic, worldwide

uid `air-traffic-world`. Tags `duckdb`, `kepler`, `live`, and the new theme
tag `aviation` (added to `dashboards/README.md` in the same change). Refresh
60 s.

1. **Live.** Every aircraft from `/adsblol/world`: points coloured by
   altitude, rotated by track. Stat tiles: aircraft now, on the ground,
   emergency squawks (7500, 7600, 7700).
2. **History, by time range.** Server-side aggregates only:
   - Traffic density by H3 cell (`cell`, coarsened as the range grows).
   - Aircraft in the air per hour, with gaps from the polls log shown as
     gaps, not as zero traffic.
   - Top airlines (ICAO prefix of the callsign) and aircraft types.
3. **Tracks, filtered.** Only for a picked aircraft, a callsign, or a drawn
   area (the existing `areaFilter` predicate), with a row cap and
   simplification. Kepler's trip layer replays them; the picked aircraft also
   gets an altitude and speed profile.

Raw history never goes to the browser unfiltered: a day is millions of rows.

The description names adsb.lol, its licence and its uneven coverage.

**Gallery or Plus.** Gallery if the free Kepler panel's trip layer and
picking to a variable are enough; Plus otherwise. Decided while building.

## Verified while building

- The live query over the whole world: 1.5 s on a cache miss, 0.4 s on a hit.
- The variable's query on the running stack, through `/api/ds/query`: the
  time macros select the right files by range (6 h, 90 min), and a range with
  nothing recorded lists the empty file only. The panel query over the
  interpolated list: 124,000 rows in 43 ms; zero rows, no error, over the
  empty file.
- The interpolation itself, by reading the code: the datasource's
  `applyTemplateVariables` goes through Grafana's `templateSrv`, where an
  explicit `:singlequote` with `All` and no custom all value gives every
  option. Not yet seen in a browser: the instance's Git Sync is `github`, so
  a scratch dashboard cannot be loaded from a local file. The dashboard's own
  test (Task 5) is where it is seen.
- **Gallery.** The free Kepler panel (1.1.0) builds an animated Trip layer
  from a trip id, a time and a position, and publishes clicks and drawn areas
  to dashboard variables.

## Still to verify

- The real size of a day of Parquet.

## Testing

- `tests/stack/feeds.test.mjs`: `/adsblol/world` reaches DuckDB, a second
  read is a cache HIT.
- `tests/stack/flight-recorder.test.mjs`, with the profile on: within two
  intervals a minute file and the manifest appear, DuckDB in grafana reads
  them through `http://feeds/recordings/`, and the columns match the table
  above. Without the profile: the fallback manifest and the empty file.
- Recorder logic (dedupe, merge, retention, crash recovery): pytest in the
  image, against fixture JSON, no network.
- `tests/stack/air-traffic-world.test.mjs`: every panel query of the
  dashboard runs, as for the other dashboards.
