# Spatial sources: recipes by data family

Each recipe is proven in a working dashboard: here (`plus/…`, `dashboards/gallery/…`) or in
the free panel's bench, [`provisioning-sources/dashboards/`](https://github.com/ubica-ecuador/keplergl-grafana-panel/tree/main/provisioning-sources/dashboards)
(written **bench:** below). The bench runs a different stack: its recipes may `INSTALL`, read
local files or call services this stack lacks; the notes say what to change. For every kind of
data the panel's guide has a page, under `https://docs.ubica.dev/guide/data/` (`points`,
`geometry`, `trajectories`, `flows`, `rasters`, `imagery-over-time`, `wms`,
`arcgis-image-service`, `zarr`, `velocity-fields`, `symbols`; start with
`how-a-query-becomes-a-map`) and `https://docs.ubica.dev/guide/sources/` (`duckdb-geoparquet`,
`erddap`, `icechunk`, `infinity`, `measuring-imagery`, `other-sql`, `stac-catalogs`).

## Rules for every recipe

- **Column names are the interface** (kepler.md): `latitude`/`longitude`, `geometry`/`geojson`,
  `h3`, `lat0…lng1`, `raster_url`, `wms_url` + `wms_layer`, `esri_url`, `zarr_url` + `zarr_variable`.
- **Geometry leaves DuckDB as text**: `ST_AsGeoJSON(g)::VARCHAR` (the cast is required, or the
  Go driver fails on a map type), `ST_AsText(g)` or `ST_AsHEXWKB(g)`. A raw `GEOMETRY` draws
  nothing. Never `SELECT *` from `ST_Read`. Reproject with `always_xy := true`.
- **Reduce on the server**: aggregate, `ST_Simplify` / `ST_ReducePrecision` polygons. Points are
  comfortable up to 10⁴–10⁵ rows.
- **Imagery rows make a second, row-less dataset** (`grafana-<refId>-raster|wms|zarr`). One
  row per `time` makes a catalogue: the map's clock shows the newest scene in its window. No
  time column: the first row wins, so `ORDER BY … LIMIT 1` picks. Never feed the map's own window
  variables back into its imagery query.
- **The browser fetches WMS, PMTiles and Esri ImageServer tiles itself**: the host needs CORS.
  COGs and Zarr go through a tile server instead.
- pacha's tile server: `http://titiler/` from DuckDB and Infinity, `/titiler/` through the
  gateway for the browser. It has an Icechunk opener (`images/titiler`, `ICECHUNK_PRELOAD`).

## Vector files

**GeoParquet / Parquet** (bench: `sources.json`; pacha: `geolife-mobility`, `melbourne-city-sensors`):

```sql
SELECT name, population, ST_AsGeoJSON(geometry)::VARCHAR AS geojson FROM read_parquet('https://…/zones.parquet');
```

With `spatial` loaded, a GeoParquet `geometry` is already `GEOMETRY`: `ST_GeomFromWKB` on it
is a binder error.

**Large Parquet pruned by the viewport** (bench: `ancestry.json`): `viewportVariables` on the
map, then `WHERE longitude BETWEEN ${west:raw} AND ${east:raw} AND latitude BETWEEN ${south:raw} AND ${north:raw}`,
with a sampling bucket that grows with the visible area. The file must be sorted spatially
(by an H3 cell, or `lindel` Hilbert order) so row-group statistics prune the read. This is
the one case where a map deliberately reads its own viewport, as density control.

**Overture Maps through its STAC index, no credentials** (bench: `r5-calles.json`): the
release from `https://stac.overturemaps.org/catalog.json` (`latest`), the files from
`…/<release>/collections.parquet` filtered by bbox, then `read_parquet` of the
`https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/…` URL. `s3://` resolves to the
wrong region. The index answers 429 after about 5 reads: read it once per load.

**Remote CSV, JSON, GeoJSON** (pacha: `earthquakes`):
`read_json(url)` + `unnest(features) AS t(f)`, then `f.geometry.coordinates[2]::DOUBLE AS latitude`.
`read_csv` for CSV; `maximum_object_size` for big JSON. `SET force_download = true` only for
endpoints that rebuild the file per request, and only through the gateway's cache in pacha
(it persists on the shared connection).

**XLSX** (pacha: `international-migration`): `read_xlsx(url, sheet=…, range='A11:AE40000', all_varchar=true)`,
then `UNPIVOT`. Join to Natural Earth centroids for flows. When nothing matches, emit one
all-NULL row so the map replaces old arcs instead of keeping them.

**Shapefile, GeoPackage, FlatGeobuf, KML, GPX, OSM, GTFS** through GDAL: `ST_Read('/vsicurl/https://…')`;
a zip: `/vsizip//vsicurl/http://feeds/…/file.zip/inner.csv` (pacha: `animal-movement-tracking`
jaguars); a shapefile through the gateway: `spain-daily-mobility` centroids. `SELECT short_name FROM ST_Drivers() WHERE can_open`
lists the drivers.

**Lines from points**: `ST_MakeLine(list(ST_Point(lng, lat) ORDER BY seq))` per route
(bench: `trimet-live.json`). **Polygons from rings in JSON**:
`'POLYGON((' || array_to_string(list_transform(ring, c -> c[1] || ' ' || c[2]), ', ') || '))'`
(pacha: `nyc-taxi-trips`).

## Vector services

**Esri FeatureServer** (bench: `aqueduct.json`, `storm-reports.json`): Infinity, `f=geojson`
(geometry → a string column `geojson`) or `f=json` with `attributes.*`; `maxAllowableOffset`
simplifies on the server; offset pagination (`resultOffset=${__pagination.resultOffset}`);
an envelope filter `geometry=xmin,ymin,xmax,ymax&geometryType=esriGeometryEnvelope&inSR=4326`.
Times as `timestamp_epoch`. A service's own H3 grid (`grid_id` → `h3`) needs no H3 at all.

**WFS / OGC API Features**: Infinity GeoJSON with
`?service=WFS&version=2.0.0&request=GetFeature&typeNames=ns:layer&outputFormat=application/json&srsName=EPSG:4326&count=5000`
(`srsName` is required, or GeoServer answers in its native CRS); or `ST_Read('WFS:https://…')`.
OGC API Features is plain GeoJSON at `/collections/<id>/items?bbox=…&limit=…`. No dashboard uses
either yet.

**Any GeoJSON service in SQL** (bench: `r5-accesibilidad.json`):
`SELECT minutes, ST_AsHEXWKB(geom) AS geom FROM ST_Read('http://…/iso.geojson?lat=' || $lat || …)`.
An endpoint that answers HEAD with 405 reaches DuckDB as "HTTP 0".

**PostGIS**: there is no PostgreSQL datasource in pacha.

## Rasters: COG, STAC, Esri ImageServer, WMS, WCS

**STAC search → scenes** (bench: `raster.json`, `raster-time.json`), server DuckDB with `http_client`:

```sql
WITH resp AS (SELECT http_get('https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a'
    || '&bbox=-79.10,-3.05,-78.90,-2.85&datetime=' || $__timeFrom() || '/' || $__timeTo() || '&limit=200') AS r),
features AS (SELECT unnest(json_extract(r->>'body', '$.features[*]')) AS f FROM resp)
SELECT (f->'properties'->>'datetime')::TIMESTAMPTZ AS time, f->>'id' AS scene_id,
       (f->'properties'->>'eo:cloud_cover')::DOUBLE AS cloud_cover,
       f->'assets'->'visual'->>'href' AS raster_url
FROM features ORDER BY time
```

Options: `rasterServerUrl` (pacha's own tiler), `rasterColormap` for single-band. Band
combinations: also return `raster_item_url` and set `rasterBands` (`forestBurn`, `infrared`,
`nbr`, `ndmi`, or `$bands`). earth-search caps a page at 200 items. A float32 COG draws only with
band statistics in its STAC metadata; uint16 is safest.

**A fixed COG**: `SELECT '<url>.tif' AS raster_url`. The tile server reads it, so an internal
URL works. Classified rasters (land cover) with their own palette: `rasterPainted: true`.
**PMTiles**: a `.pmtiles` URL is read by the browser directly, no tile server, needs CORS
and ranges.

**STAC footprints against a drawn area** (bench: `stac-join.json`): `areaVariable`, then
`SET VARIABLE drawn = nullif($aoiArea, '')`, a bbox from it for the search,
`ST_Intersects(geom, ST_GeomFromGeoJSON(f->>'geometry'))`, coverage share with an equal-area
`ST_Area(ST_Transform(g, 'EPSG:4326', 'EPSG:6933', always_xy := true))`. Emit the scene date as
text, or the map's clock becomes a second scene picker. A thumbnail column for a table:
`<tiler>/cog/bbox/{xmin,ymin,xmax,ymax}.png?url=<href>&max_size=128`.

**Measuring a COG**: Infinity `POST http://titiler/cog/statistics?url=${cog:percentencode}` with
a GeoJSON Feature body (root `properties.statistics.b1`); `GET http://titiler/cog/point/${lng},${lat}?url=…`
for a clicked value. Or the `raster` extension: `RT_Read(getvariable('path'))` (literal path
through `SET VARIABLE`), `RT_CubeClip`, `RT_CubeStats_Agg`; remote reads need
`SELECT RT_GdalConfig('CURL_CA_BUNDLE', '/etc/ssl/certs/ca-certificates.crt')`; use
`open_options := ['OVERVIEW_LEVEL=3']` on big scenes; tiles are in the scene's CRS. Writing a
COG (`COPY … FORMAT RASTER`) is impossible in pacha (no local files).

**Esri ImageServer** (bench: `esri-image.json`, `lulc.json`): no tile server.
`SELECT '<…/ImageServer>' AS esri_url, '{"mosaicMethod":"esriMosaicAttribute","where":"Year=' || $year || '"}' AS mosaic_rule`
(optional `rendering_rule`). One row per `time` walks the years. Histograms over an area:
Infinity `…/computeHistograms`; a clicked value: `…/identify`.

**WMS with its calendar** (bench: `wms-time.json`): give the bare endpoint and the layer:
`SELECT '<https://…/wms>' AS wms_url, $layer AS wms_layer`. With no time column, the panel reads
`<Dimension name="time">` from GetCapabilities itself. With one, parse GetCapabilities in SQL
(`http_get(…GetCapabilities)->>'body'`, `regexp_extract` the dimension, `unnest(str_split(…))`).
Click → value: `variableMappings [{source:"click", field:"wms_value", variable:"rain"}]`.
**WCS numbers** for the same layer: `RT_Read('/vsicurl/…?service=WCS&version=2.0.1&request=GetCoverage&coverageId=…&subset=Long(a,b)&subset=Lat(c,d)')`
(band index 0-based; one request per day).

## Multidimensional: Zarr, Icechunk, ERDDAP

**Zarr through the tiler** (bench: `zarr-stats.json`):

```sql
SELECT make_timestamp(2020, m, 1, 0, 0, 0)::TIMESTAMPTZ AS time,
  'https://…/tavg-prec-month' AS zarr_url, 'climate' AS zarr_variable, 6 AS zarr_levels,
  'band=tavg' AS zarr_sel, 'month' AS zarr_time_dim, m::TEXT AS zarr_time_label
FROM generate_series(1, 12) t(m) ORDER BY time
```

`zarrRescale` is required (`"-20,40"`): without it every tile stretches over its own extremes.
`zarr_time_label` must equal xarray's label exactly (find them with the tiler's `/zarr/info`).
Statistics over a drawn area: Infinity `POST http://titiler/zarr/statistics?...`.

**Icechunk GFS forecast** (bench: `gfs-forecast.json`; pacha's tiler preloads it):
`'stac+https://stac.dynamical.org/noaa-gfs-forecast/collection.json' AS zarr_url`,
`'lead_time' AS zarr_time_dim`, the lead in nanoseconds as `zarr_time_label`, the run in
`zarr_sel` (`'init_time=' || strftime(init, '%Y-%m-%dT%H:%M:%S.000000000')`), a
`zarr_rescale` per variable. Wind as vectors: a lattice of points sent in batches to
`/zarr/statistics` with `http_post`, output `latitude, longitude, u, v` (bench: `gfs-wind.json`).

**ERDDAP grids as CSV** (pacha: `gfs-wind-synoptic`, through `http://feeds/erddap/`):
`.csv0` (no header rows), escape only `[` `]`, every variable with a byte-identical subset (or
ERDDAP answers 400, which DuckDB reports as "HTTP 0"), longitudes 0..360 → `-360`. Drop land
rows rather than sending NULLs: a NULL wind is drawn as calm. The lattice spacing must not
wobble more than 5 %, or the velocity layers draw nothing. A ±0.25° square `geojson` per cell
from the same rows gives a coloured background.

## Grids: H3, A5, S2

- Compute H3 **on the server** (Chaski has no h3):
  `h3_latlng_to_cell_string(latitude, longitude, 8) AS h3`, aggregated (`GROUP BY 1`) before it
  leaves; `h3_to_string`, `h3_cell_to_parent`, `h3_cell_to_lat`/`_lng` around it. pacha:
  `geolife-mobility`, `air-traffic-world`, `denmark-ais-trajectories` (`hexagonId` layer).
- H3 flows: `origin_h3`, `dest_h3`, `count` (bench: `nyc-taxi-live.json`).
- A5 (`a5` extension) and S2 (`s2` column) cells: loaded or detected, but no dashboard uses them yet.

## Tables and lakes

**Iceberg** (`iceberg` + `avro` loaded on the server): `iceberg_scan('<metadata or table url>')`,
with snapshots for time travel. On the backlog in `dashboards/README.md`; no dashboard yet.
**A dataset built once per instance**: `datasets/<name>/build.sh` (see engines.md).

## Live feeds

- GTFS-RT JSON (pacha: `gtfs-rt-mbta-fleet`): `read_json('http://feeds/mbta/realtime/…json', maximum_object_size=50000000)`,
  `unnest(entity) AS e`, `e.vehicle.position.latitude AS latitude`, `….bearing::DOUBLE AS heading`.
- One request per station with `http_get` and whole-hour windows (pacha: `air-quality-amsterdam`).
- Several files in one read: `read_json([url1, url2], filename = true)` + `regexp_extract(filename, …)`;
  daily files: `read_parquet([… FOR d IN generate_series(…)])`.
- Every live source goes through the gateway with a cache no shorter than its update interval;
  history the dashboard needs beyond the source's own lives in the recorder
  (`recorder/feeds/*.sql`, served at `http://feeds/recordings/…`; `air-traffic-world`).

## 3D

`tile3d` layer for 3D Tiles (pacha: `agi-hq-grid-cameras`; bench: `tile3d.json`): the tileset lives
only in the saved `mapConfig` (Add Data → Tileset); the query can be `SELECT 1 AS nothing WHERE false`.
Extruded buildings: polygons with a height column and the geojson layer's `enable3d`
(`nyc-skyline-plus`, `nyc-taxi-trips`).
