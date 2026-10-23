# Engines: server DuckDB, Chaski, Infinity

Three datasources, referenced by uid only. Pick one per dataset, not per dashboard: most
dashboards here mix them.

| | DuckDB on the server | Chaski (DuckDB-WASM in the browser) | Infinity |
|---|---|---|---|
| uid / group | `duckdb` / `motherduck-duckdb-datasource` | `duckdbwasm` / `ubica-chaski-datasource` | `infinity` / `yesoreyeram-infinity-datasource` |
| Runs | in the grafana container, per panel query | in each viewer's browser, once per load, then every panel queries in memory | the Grafana backend fetches a URL |
| Extensions | httpfs, spatial, json, excel, raster, http_client, avro, iceberg, h3, a5, lindel. Nothing else: no `INSTALL`, no local files | core only; **no h3**, no http_client, no raster. `spatial` costs a 23 MB download: avoid it | none: JSON, CSV, XML, GraphQL, paginated |
| Reaches | the internet and the gateway's `http://feeds/...`, `http://titiler/` | only URLs that send CORS headers; never `feeds` | the internet and the gateway |
| Use for | big remote files, anything keyed or cached by the gateway, H3/A5 cells, spatial joins, `http_get` loops, STAC, rasters | interactive dashboards: cross-filters, brushes, clicks re-answered without a round trip | a plain JSON API, Esri FeatureServer, paginated services |

The usual shape of a rich dashboard: **the server reads and reduces the source, Chaski holds
the result, every panel queries Chaski.** That is a Chaski dataset whose source is a server
query (below).

## Server DuckDB

A panel query:

```json
"query": {
  "datasource": { "name": "duckdb" },
  "group": "motherduck-duckdb-datasource",
  "kind": "DataQuery",
  "spec": { "format": 1, "rawQuery": true, "rawSql": "SELECT ..." },
  "version": "v0"
}
```

- `"format": 1` (table). A hand-written `"table"` returns an empty frame.
- **Quoting:** the datasource quotes a variable itself. Write `$var`, never `'$var'` (which
  arrives as `''value''`). Inside a string you build, use `${var:raw}` and validate it
  (`WHERE regexp_full_match('${station:raw}', 'NL[0-9]{5}')`). Any format modifier turns the
  automatic quotes off. Multi-value: `IN (${era:singlequote})`.
- **Guard empty variables**, which every channel can be: `coalesce(try_cast($from AS TIMESTAMPTZ), '-infinity'::TIMESTAMPTZ)`,
  `nullif($area, '')`.
- **Time:** `$__timeFilter(col)`, `$__timeFrom()`, `$__timeTo()`, and `${__from}` / `${__to}`
  in epoch ms (`make_timestamp(CAST(${__to} AS BIGINT) * 1000)`).
- **Multi-statement SQL works:** `SET VARIABLE w = (SELECT ...); SELECT ... read_json('http://feeds/x?' || getvariable('w'))`
  builds a URL from data in one query. `SET VARIABLE x AS` is a syntax error; use `=`.
  Functions that need a literal path (`RT_Read`, `read_parquet` of a computed name) take
  `getvariable('x')`.
- **HTTP in SQL:** `http_get(url)` / `http_post(url, headers, body)` return
  `{status, body}`; check `r->>'status' = '200'` and parse `(r->>'body')::JSON`. They give up
  after about 10 s: batch.
- **Make URLs cacheable:** round time windows to whole hours (or the source's step) so one URL
  stands for a window, and the gateway can answer every visitor from one copy.
- `strftime` has no `TIMESTAMPTZ` overload: cast to `TIMESTAMP` first. A bare `QUALIFY` with no
  window function errors.
- Geometry out to Kepler: never a raw `GEOMETRY` (it arrives as bytes and draws nothing).
  Use `ST_AsGeoJSON(g)::VARCHAR`, `ST_AsText(g)` or `ST_AsHEXWKB(g)`. Reproject with
  `ST_Transform(g, 'EPSG:x', 'EPSG:4326', always_xy := true)`; without `always_xy` the axes
  swap.
- H3: `h3_latlng_to_cell_string(lat, lng, res)` (latitude first), as a string column named
  `h3`. Aggregate before you send.

### Data the server reads through the gateway

The gateway's `feeds` server (`gateway/feeds.conf`) is the only way for a key, a cache or a
politeness limit: DuckDB calls `http://feeds/<source>/...`. Each `location` adds the key from
`.env` through envsubst (never in a dashboard), caches for the source's real update interval,
and serves stale on errors. Adding a source means a new `location` there, validated with
`docker compose run --rm --no-deps -T gateway nginx -t` before a restart.
Datasets too big or too slow to read per visit are built once per instance:
`datasets/<name>/build.sh` + `build.sql`, outputs gitignored, served at
`http://feeds/datasets/<name>/<file>.parquet` (to DuckDB only). An instance that has not run
the build shows errors on that dashboard.

## Chaski

Chaski data comes in two forms.

**A dataset**: a hidden `QueryVariable` that loads a table into the browser once per load.
Panels then read it as `$name`, like a table.

```json
{
  "kind": "QueryVariable",
  "spec": {
    "name": "quakes", "hide": "hideVariable", "refresh": "onDashboardLoad", "skipUrlSync": true,
    "current": { "text": "", "value": "" }, "options": [], "includeAll": false, "multi": false,
    "allowCustomValue": true, "regex": "", "regexApplyTo": "value", "sort": "disabled",
    "query": {
      "datasource": { "name": "duckdbwasm" }, "group": "ubica-chaski-datasource", "kind": "DataQuery", "version": "v0",
      "spec": { "kind": "dataset", "name": "quakes", "refId": "quakes",
                "source": { "type": "sql", "sql": "SELECT ... FROM read_json('https://...')" } }
    }
  }
}
```

- `source.type: "sql"`: the browser runs the SQL, so every URL needs CORS.
- `source.type: "datasource"`: another datasource fills it, usually the server DuckDB.
  `source` then holds `datasource` (`{type, uid}`) and `query` (a full DuckDB query with
  `rawSql`, `format: 1`, `refId`). This is how server-only data (keys, the gateway, h3,
  `http_get`) reaches Chaski. Write `-- Server side: ...` as the first comment line, as every
  dashboard here does.
- A dataset can read another: `SELECT ... FROM $quakes`.
- A dataset's name must not equal another variable's name (dataset `trip` beside a text
  variable `trip` broke both).

**A panel query** reads datasets with SQL: `"spec": { "rawSql": "SELECT ... FROM $quakes WHERE $__timeFilter(time)" }`.
Macros: `$__timeFilter`, `$__timeGroup(time, 1d)`, `$__timeFrom`, `$__timeTo`, `$__interval`,
and the cross-filter macros below.

**Cross-filters** (Chaski 1.2.0). Panels that filter each other (a brush, a drawn area, the map's
time slider, a picked value) write variables; declare once which column each one narrows, in a
hidden `filters` variable beside the dataset, and every panel applies them with one macro:

```json
"query": { "datasource": { "name": "duckdbwasm" }, "group": "ubica-chaski-datasource", "kind": "DataQuery", "version": "v0",
  "spec": { "kind": "filters", "refId": "quakeFilters", "dataset": "$quakes", "filters": [
    { "name": "time", "label": "Time", "type": "range", "column": "time", "as": "time", "from": "$quakeFrom", "to": "$quakeTo", "upper": "closed" },
    { "name": "mag", "label": "Magnitude", "type": "range", "column": "mag", "from": "$mag_lo", "to": "$mag_hi" },
    { "name": "area", "label": "Area", "type": "area", "variable": "$quakeArea", "lat": "latitude", "lng": "longitude" } ] } }
```

```sql
SELECT floor(mag / 0.5) * 0.5 AS bin, count(*) AS n FROM $quakes
WHERE $__timeFilter(time) AND $__crossfilter($quakeFilters, -mag)   -- every filter but its own
```

- The variable (named `quakeFilters` here) is a `QueryVariable` like the dataset's, hidden,
  `refresh: onDashboardLoad`. Write the dataset and every variable it reads as `$name`: that is
  how Grafana refreshes it, and the panels naming it, when one changes.
- Pass the filters variable to the macros, never the dataset: a query naming only `$quakes`
  would not run again when a filter moves.
- A panel leaves out the filter it writes (`-mag` in the histogram that brushes `mag_lo`/`mag_hi`),
  or it would narrow itself and could never widen again. The map filters in kepler: no macro.
- Types: `range` (`as: number|time`, `upper: open|closed`), `in` (multi-value), `equals`,
  `search`, `area` (the WKT kepler writes; no `spatial` needed), `link` (`filters` = another
  dataset's filters variable, `column`, `to`: a cohort). Columns are names, not expressions:
  derive them in the dataset (`depth_axis` in earthquakes). Values are parsed and quoted by
  Chaski, never pasted into the SQL; times compare as UTC.
- `$__filters($quakeFilters)` is a table of the declared filters (`name, label, active, value,
  variables`) for a filter bar: `assets/filter-bar.js` in a Business Text panel.
- The server DuckDB has no such macros: there, filters stay hand-written (kepler.md).

**A values variable** fills a dropdown from a dataset:
`"spec": { "kind": "values", "refId": "flight", "sql": "SELECT x AS value, label AS text FROM $flights" }`.
It hands integers back as doubles (`11388.0`), which then land in URLs and cache keys: cast
`col::BIGINT::VARCHAR` for both value and text.

Chaski traps:
- `SUM(BIGINT)` is `HUGEINT`, which DuckDB-WASM sends as an object, not a number: cast sums to
  `DOUBLE`.
- Native `barchart` (and a monthly-bar `timeseries`) over Chaski frames drew nothing in
  `spain-daily-mobility` (legend, no bars; cause unknown), while a daily `timeseries` works in
  `earthquakes`. For bar charts over Chaski use Business Charts; stat and table are fine.
- Memory limit is 1 GB per viewer: reduce on the server first.
- Point in a drawn polygon without `spatial`: an `area` filter with `$__crossfilter` (above);
  `assets/area-filter.sql` is the hand-written form, for a dataset with no filters variable.

## Infinity

```json
"spec": { "type": "json", "parser": "backend", "source": "url", "url": "https://...", "root_selector": "features",
          "url_options": { "method": "GET" },
          "columns": [ { "selector": "properties.mag", "text": "mag", "type": "number" } ] }
```

- `url_options.method` is required in hand-written JSON.
- CSV columns are strings by default: type latitude and longitude as `number` or every point
  lands at (0, 0). A GeoJSON `geometry` selector typed `string` gives Kepler a `geojson` column.
- Epoch times: type `timestamp_epoch`.
- Pagination (Esri): `pagination_mode: "offset"` with `${__pagination.resultOffset}`.
- `"source": "inline"` with `"data": "[{\"time\":\"${map_from}\",\"timeEnd\":\"${map_to}\",\"text\":\"On the map\"}]"`
  turns variables into a frame: used as an annotation-like region that shows the map's time
  window on a time series (`gps-truck-track`, `germany-power-borders`).
- Examples: `dashboards/gallery/gps-truck-track.json`, `plus/dashboards/germany-power-borders.json`.
