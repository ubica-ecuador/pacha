# Gotchas: silent failures and their fixes

Each one cost a debugging round. Check here first when something looks wrong. Add new ones
here, in the same shape: symptom, cause, fix.

## Maps

| Symptom | Cause | Fix |
|---|---|---|
| The map ignores its saved layers: default palette, coloured by the first numeric field | the saved layer points at `lat`/`lng`; the panel renamed the columns to `latitude`/`longitude`, so the layer found none and kepler fell back to automatic layers | name the SQL columns `latitude`/`longitude`, and `columns: {lat: 'latitude', lng: 'longitude'}` |
| The whole `mapConfig` is ignored | no top-level `"version": "v1"`, or `visualChannels` nested inside `config` | `{"version":"v1","config":{…}}`; `visualChannels` beside `config` |
| Empty map on a historical dataset | relative time range (`now-6h`) | save an absolute UTC range covering the data |
| Times off by hours | Kepler's clock is UTC | dashboard `timezone: "utc"`, ranges in UTC |
| Geometry column draws nothing, no error | raw DuckDB `GEOMETRY` sent as bytes | `ST_AsGeoJSON(g)::VARCHAR`, `ST_AsText`, or `ST_AsHEXWKB` |
| Polygons in the wrong place or NULL areas | `ST_Transform` without `always_xy := true` swaps axes | add `always_xy := true` |
| A vehicle table becomes trip lines | a column named `vehicle_id` (a trip-id role) | call it `vehicle`, or set the role to None |
| A track drawn high above the ground, vanishing when zoomed in | altitude mapped from an elevation above sea level | leave Altitude unmapped (it is opt-in for this reason) |
| Clicks publish nothing, `clickConfirm` opens no popup, on every layer of the map | the map has a **Trip** layer: kepler never sets `visState.clicked` then | select from a table row data link instead, with an "All …" row that clears |
| Every point of a filtered map gets an amber ring | the panel rings rows whose clicked column equals the variable; the map is already filtered to the selection | don't feed the selection back into the map's query |
| The map filters itself and cannot widen again | its own published variable (area, viewport, click) is in its own query | only other panels read it; the map filters with kepler filters |
| "`takeoff` doesnt exist in dataset grafana-A" in the console; a saved filter or a Mosaic clause on that time column does nothing | the panel's time role renames the first time column to `time` when none is called that | keep a column named `time` in the query (the one the map animates on), and other time columns keep their names |
| Flow layer stays yellow whatever `colorRange` says | flow layer ignores the palette | accept it, or use a Traffic layer; readable with `flowLinesRenderingMode: straight`, `flowLineThicknessScale` ~0.35 |
| Fleet trails join thousands of assets into scribbles | `fleetAssetField: auto` picked a low-cardinality string column | set `fleetAssetField` and `fleetTimeField` explicitly |
| A line across the whole world | track crosses the antimeridian | unwrap longitudes per asset in SQL, then shift so the newest point is in [-180, 180] |
| `fleetTimeRef: live` shows no vehicle at wall-clock now | the range reaches past now, so "now" is the end of the data | keep the range ending at `now` |
| Fleet cards with no chart | a card's chart needs ≥ 2 readings in its window | widen `fleetCardWindow`, or accept |
| A map that should follow the selection stays put | saved `mapState` | save without `mapState` and add a `center` mapping with `zoom` |
| A map whose data changes (another state, another region) stays where it was | the panel frames its data on load only, and a `center` mapping moves it at a fixed `zoom` | name the variable in the panel option `fitOnVariables` (free panel after 1.4.0; edge on pacha): the map frames the new rows at the zoom they need (`ancestry-esda`) |
| The `center` mapping ignores a change back to a place it has shown before | it skips a lat/lng pair it has already centred on, so as not to fight the user's panning | make each value new: nudge it by the clock, `+ (epoch_ms(now()) % 1000) * 1e-6` (`ancestry-esda`) |
| Velocity layer draws nothing | lattice spacing wobbles > 5 %, or `u`/`v` NULL over land | regular lattice; drop land rows instead of NULLs |
| Zarr tiles look like patchwork | no `zarrRescale` | set `min,max` in the store's units |
| Raster colours like confetti | kepler's default ramp is for NDVI | set `rasterColormap`, or `rasterPainted` for classified rasters |
| CARTO base map watermarked | `dark-matter`/`positron`/`voyager` need a key since 2026-09 | use `openfreemap-*` |
| Plus panels show ChunkLoadError after a plugin deploy | Grafana registers plugin files at start | restart grafana; users hard-reload (chunks are cached 1 h) |
| "charts follow the map view" leaves out part of the world on load | Kepler writes `viewportVariables` as soon as it draws, and a world view in a 16-column panel spans about -106..136 longitude | default to the whole Earth and offer the view as a choice (`firms-active-fires`, variable `scope`) |
| The time brush updates every panel except the map | the map query already aggregates for the brush variables, and kepler also puts a time filter on any time-shaped column of that result (`last_seen` looked like `2026-10-12 18:00 UTC`). Widening the brush re-queries, then the filter keeps its old window because the new value still lies inside the new data, so the new cells never draw | one time filter, on the layer that is not re-queried (the smoke clock). A label on the aggregated rows must not look like a timestamp (`firms-active-fires`, `seen 14 Oct at 18:04 UTC`) |

## SQL and engines

| Symptom | Cause | Fix |
|---|---|---|
| `''value''` parse error | `'$var'` on the DuckDB datasource, which quotes itself | `$var`; `${var:raw}` inside a string you build |
| A DuckDB `QueryVariable` fails with `Referenced column "IL" not found` | the datasource quotes `$var` in panel and dataset queries, not in a variable's own query | `${var:sqlstring}` there |
| Random draws from `hash(p, m)` are not independent: permutation p-values drift | DuckDB's multi-argument `hash` combines by XOR: `xor(hash(1, m), hash(2, m))` is the same for every `m` | hash one integer: `hash(p * 4294967296 + m)` |
| A query that indexes a list from a one-row CTE (`pool.zs[i]`) after a large cross join runs out of memory; on the server it killed the DuckDB plugin | the list is carried on every row of the join | join on an integer position instead (`ancestry-esda`, dataset `lisa`) |
| Empty frame from a hand-written DuckDB query | `"format": "table"` | `"format": 1` |
| `strftime` binder error | no `TIMESTAMPTZ` overload | cast to `TIMESTAMP` first |
| `QUALIFY` error | bare `QUALIFY` without a window function | use a subquery |
| `SET VARIABLE x AS …` syntax error | wrong syntax | `SET VARIABLE x = (…)` |
| A dropdown value `11388.0` in URLs and cache keys | Chaski `values` hand integers back as doubles | `col::BIGINT::VARCHAR` for value and text |
| A sum renders as `[object Object]` or breaks a chart | `SUM(BIGINT)` → `HUGEINT`, serialised by DuckDB-WASM as an object | cast sums to `DOUBLE` |
| `h3_*` not found in Chaski | no H3 in the browser | compute on the server in the dataset's source query |
| Every Mosaic panel goes blank for seconds when a picker changes | a Chaski dataset whose SQL reads the picker reloads, and any dataset reload rebuilds every Mosaic panel of the dashboard | keep pickers out of dataset SQL: put the pick in the filters variable (`equals` on the column) or a Mosaic `reads`, and filter the one dataset in panel queries (`drone-delivery-flights`) |
| Two variables break each other | a Chaski dataset and another variable share a name | unique names |
| Native barchart over Chaski shows a legend and no bars | unknown | Business Charts for bars over Chaski |
| `array_extract(VARCHAR[], DOUBLE)` binder error in Chaski on `list[n + 1]` | every numeric column of a server-fed dataset reaches the browser as DOUBLE | cast the index: `list[(n + 1)::BIGINT]` |
| "Cannot compare TIMESTAMP_MS and TIMESTAMP WITH TIME ZONE" in Chaski | a server-fed time column is TIMESTAMP_MS (naive UTC); `try_cast($var AS TIMESTAMPTZ)` is not | `try_cast($var AS TIMESTAMP)` (ISO strings with `Z` parse), and `now()::TIMESTAMP` (Chaski's TimeZone is UTC) |
| Stacked ECharts bars all start from zero | `stack` does not stack on a value or time x axis | a category axis per bin (a hidden time axis can carry the brush) |
| Infinity: "unable to merge fields due to different fields" on a filtered query | offset pagination asks for more pages than the filter leaves; the empty ones have no fields | don't filter the paginated query; filter in the map (kepler `variableMappings`) or fetch fewer pages |
| A stat of a time value shows "No data" | `reduceOptions.fields: ''` takes numeric fields only | `fields: "/.*/"` (as for a `dateTimeFromNow` "Latest data" stat) |
| A stat or table of a picked entity shows minuscule or truncated text | a long name in a narrow stat scales down; a table truncates | a Business Text panel (`marcusolsson-dynamictext-panel`, `renderMode: everyRow`) with a small HTML template (`fiware-valencia`) |
| A Business Chart writes a variable on click but its highlight stays on the old value | the panel redraws only when its query or code names that variable | name it: `${var}` in the code (redraws without re-querying) or `-- ${var:raw}` in the SQL |
| "Malformed JSON", about 1 query in 800, on a feed refreshed often | DuckDB's external file cache mixed two versions of a file | already off instance-wide; don't turn it on |
| "the remote file has changed" | a source that rebuilds the file per request | cache it in the gateway |
| "HTTP 0" from DuckDB | the server answered HEAD with 405, or ERDDAP refused a subset (400) | use another endpoint, or make every ERDDAP subset identical |
| `INSTALL` or local file read fails | by design: local filesystem off, no install | only the preloaded extensions; data from URLs |
| `http_get` times out | `http_client` gives up after about 10 s | batch; cache in the gateway |
| A gateway 404 rewritten by `error_page` comes back raw | nginx does not apply `proxy_intercept_errors` to a 404 served from cache | don't cache the status you rewrite |
| A geolife-style dashboard errors on one instance only | its `datasets/<name>/build.sh` has not run there | run it (GeoLife needs `GEOLIFE_MEMORY` ≥ 8 GB) |
| A GeoParquet `geometry` read by Chaski is a `BLOB` | no `spatial` in the browser: the native GEOMETRY type arrives as WKB | decode a point by hand: hex → `UBIGINT` → byte swap by shifts → IEEE 754 arithmetic, about 1 s per million rows (`firms-active-fires`, dataset `fires`) |
| `ST_Intersects` binder error: geometries of different CRS | GeoParquet 2.0 says `OGC:CRS84`, Natural Earth `EPSG:4326` | cast both to plain `GEOMETRY` (same axes), or `ST_SetCRS` |

## Grafana

| Symptom | Cause | Fix |
|---|---|---|
| Conditional rendering does nothing | it is on a `GridLayoutItem` | put it on a `RowsLayoutRow`, `TabsLayoutTab` or `AutoGridLayoutItem` |
| A panel empty in a screenshot or test | lazy rendering below the fold | scroll it into view first |
| A narrow table shows two columns and scrolls | Grafana 13's wide minimum width | `custom.minWidth` ~40 and per-column widths |
| The file changes after the first save in Grafana | hand-written formatting drifts from Grafana's | expected, once; commit Grafana's version |
| Admin login refused for minutes | failed logins from helpers without `.env` | always `--env-file=.env` |
| `localhost` refused from Node | Node resolves it to `::1` | `127.0.0.1` |
| Chromium crashes on a heavy map | default `/dev/shm` | `--shm-size=2g` |
| A Business Text panel with two queries shows an empty dropdown under its content | in `everyRow` and `allRows` modes it offers a picker of data frames | `renderMode: "data"`, and read each frame from `context.panelData.series` by `refId` (`mbta-subway-diagram`) |
| A Business Text `afterRender` draws a broken figure for a moment after a variable changes, or a WebAssembly library it feeds aborts (`Aborted(Assertion failed …)`) | while a query runs again the panel can be handed a frame without its fields: every row reads `undefined` | keep only whole rows, keep the last drawing when none are left, and keep state on `this` (`mbta-subway-diagram`, its Graphviz layout) |
| A table column hidden with `custom.hidden` still shows | Grafana 13.2's table reads `custom.hideFrom.viz` | override `custom.hideFrom.viz: true`; a data link can still use the hidden field (`firms-active-fires`, largest fires) |
