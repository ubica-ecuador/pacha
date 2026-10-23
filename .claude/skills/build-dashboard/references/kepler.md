# Kepler panels

Two panels, the same options:

- `ubica-keplergl-panel`: free. Dashboards in `dashboards/gallery/`.
- `ubica-keplerplus-panel`: Plus. It is the free panel plus eight layer types, Places, Alerts and
  paid base maps (see [kepler-plus-layers.md](kepler-plus-layers.md)). Dashboards in
  `plus/dashboards/`, tag `plus`, and only with the Plus overlay (`compose.plus.yaml`).

The full user guide is https://docs.ubica.dev (source: the free panel's `docs/site/`). The
most useful pages: `reference/panel-options`, `reference/field-roles`,
`reference/variable-formats`, `reference/troubleshooting`, the `guide/data/` pages per kind of
data, and `tutorials/`. The text below is the part an agent needs every time; it follows the
panels' own Grafana Assistant skills (https://docs.ubica.dev/plus/assistant), which the panels'
tests keep in step with their code.

## Columns: roles by exact name

The panel finds roles by **exact, case-insensitive column name**, and time by type (the first
column typed as time). Name the SQL columns accordingly:

| Role | Name it | Notes |
|---|---|---|
| Point | `latitude`, `longitude` | Use these, not `lat`/`lng`: the panel renames to latitude/longitude, and a saved layer pointing at `lat` finds nothing and falls back to automatic layers |
| Time | any `TIMESTAMP`/`TIMESTAMPTZ` | cast integers and strings in SQL |
| Trip | `trip_id` (also `track_id`, `vehicle_id`, `journey_id`…) | trip id + time + lat + lng → a Trip layer. A vehicle column you do not want as trips: call it `vehicle` |
| Geometry | `geometry`, `geom`, `geojson`, `wkt` | GeoJSON, WKT or WKB hex text, EPSG:4326 |
| H3 | `h3` | hex string, one resolution per column |
| Flow | `lat0`, `lng0`, `lat1`, `lng1` (+ `count`) | or `origin_h3`, `dest_h3` (H3 wins) |
| Count | `count`, `trips`, `weight`, `flow`, `total`, `volume` | |
| Rotation | `bearing`, `heading`, `course`, `cog` | numeric |
| Velocity | `u` + `v`, or `speed` + `direction` | no trip id in the same query |
| Imagery | `raster_url`, `raster_item_url`, `wms_url` + `wms_layer`, `esri_url`, `zarr_url` + `zarr_variable`… | detected only, never in the editor: alias the column. Makes a second dataset `grafana-<refId>-raster` etc. |
| Altitude | none | opt-in only: an `elevation` column would lift the track off the ground |

Columns without a role pass through and can colour, size, filter and label.

## The saved map: `mapConfig`

A panel option. It must be a kepler saved config **with a top-level `version`**; without it
the panel ignores the whole config silently.

```json
{"version":"v1","config":{
  "mapStyle":{"styleType":"openfreemap-dark"},
  "mapState":{"latitude":-2.9,"longitude":-79.0,"zoom":11},
  "visState":{"filters":[],"layers":[
    {"id":"speed-points","type":"point",
     "config":{"dataId":"grafana-A","label":"Speed","columns":{"lat":"latitude","lng":"longitude"},"isVisible":true,
               "visConfig":{"radius":6,"colorRange":{"name":"Custom","type":"custom","category":"Custom",
                            "colors":["#2ecc71","#f1c40f","#e74c3c"]}}},
     "visualChannels":{"colorField":{"name":"kmh","type":"real"},"colorScale":"quantile"}}]}}}
```

- The dataset id of query `A` is `grafana-A`. Layers and filters point at it.
- **`visualChannels` is a sibling of `config`**, never inside it. `dataId`, `columns` and
  `visConfig` are inside `config`.
- The panel builds automatic layers from the roles. Write a `mapConfig` to restyle or add
  layers. The best way to get a correct one: copy a layer from a dashboard with the same layer
  type (the layer types in use here: point, geojson, fleet, traffic, trip, sparkline, pipeline,
  hexagonId, coverage, hexagon, flowfield, vectorfield, tile3d, symbol, surface, gauge, flow,
  cluster, arc), or build it in the editor and **Save current map**.
- A map whose location follows a selection: save it **without** `mapState` (the panel frames
  the data on load) and add a `center` mapping to hidden lat/lng variables.
- `mapConfig` is applied when the dashboard loads: after a live edit, reload.

Base maps (`config.mapStyle.styleType`, and the panel option `basemap`): prefer
`openfreemap-positron|bright|liberty|dark|fiord`. `dark-matter`, `positron`, `voyager` are
CARTO's and need `cartoApiKey` or the tiles are watermarked. Also `grafana-satellite`,
`grafana-satellite-terrain`, `grafana-topographic-terrain`, `no_map`. Dark base map for dense
points, light for choropleths.

## Panel options

All in `panel.options`, not in `mapConfig`.

| Option | Values |
|---|---|
| `showSidePanel` | `false` on dashboards (it takes the tile) |
| `followGrafanaTheme` | `true` |
| `basemap` | as above, or `auto` |
| `timeSync` | `toMap` (range drives the map's time filter), `bidirectional`, `variables` (the slider writes `timeVariables: {"from":"t0","to":"t1"}` as UTC ISO 8601), `off` |
| `publishWhilePlaying`, `publishIntervalMs` | write the window during playback, paced (default 1500 ms) |
| `playheadVariable` | the trip animation's current instant → a variable. One map only |
| `peerTimeSync` | share the time filter with other maps that have it on |
| `tripLayerMode` | `table` (one row per point, all columns) or `geojson` |
| `flowRenderMode` | `straight`, `curved`, `animated-straight` |
| `areaVariable` | the drawn polygon or rectangle → WKT EPSG:4326; `''` when deleted |
| `clickArea`, `clickAreaSizeMetres` | a click sets the area to a square around the entity |
| `viewportVariables` | `{"west":"w","south":"s","east":"e","north":"n"}` |
| `fitOnVariables` | `["state"]`: when one of these variables changes, the map frames its new rows as on load, at the zoom they need; nothing else moves it. For pickers that move the data elsewhere. Free panel after 1.4.0 (edge on pacha) |
| `variableMappings` | see below |
| `clickConfirm` | a click only opens the popup; **Select** publishes |
| `hoverSync`, `hoverMaxAgeSeconds` | positions at the crosshair's time |
| `rasterServerUrl`, `rasterColormap`, `rasterPainted`, `rasterBands`, `zarrRescale` | imagery; see spatial-sources.md |
| `places`, `alerts` | Plus only |
| `saveRequest` | the Save-map counter; leave it |

### `variableMappings`

A list of `{field, variable, variableTo?, source?, zoom?, keepOnDeselect?}`:

- `source: "filter"` (default): a kepler filter on `field` ⇄ the variable, two-way. With
  `variableTo`, a numeric range (min → `variable`, max → `variableTo`).
- `source: "click"`: the clicked entity's `field` → the variable, one way.
  `keepOnDeselect: true` keeps it on an empty click.
- `source: "coordinate"`: the clicked place, latitude → `variable`, longitude → `variableTo`.
- `source: "center"`: the map flies to lat/lng variables set elsewhere; optional `zoom`.
- `source: "chart"`: a kepler chart's cross-filter on `field`.

### What the panel writes

Every value is a string, and every channel can be empty before the first interaction. Time
windows: UTC ISO 8601. Coordinates and viewport: degrees, 6 decimals, clamped. Area: WKT
EPSG:4326, only the latest figure, never written on load. Range filters: both bounds blanked
when the filter is removed.

**Never feed a variable a map writes into that same map's query**: the map would filter
itself and could not widen again. Other panels read it; the map filters in kepler.

Consuming in DuckDB (which quotes for you):

```sql
WHERE time >= coalesce(try_cast($t0 AS TIMESTAMPTZ), '-infinity'::TIMESTAMPTZ)
  AND ($area = '' OR ST_Intersects(geom, ST_GeomFromText($area)))      -- server, spatial
```

In Chaski, declare the map's variables in a filters variable and read them with
`$__crossfilter` (engines.md), the drawn area included.

## Free or Plus

Plus when the map needs a Plus layer (gauge, prism, coverage, surface, sparkline, traffic,
pipeline, fleet), Places (names without coordinates), Alerts, or a paid base map. Otherwise
the free panel, in the gallery. A free and a Plus panel can share a dashboard.
