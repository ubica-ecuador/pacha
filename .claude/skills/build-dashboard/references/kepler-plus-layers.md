# Kepler Plus: layers, Places, Alerts, base maps

From the Plus app's Grafana Assistant skill ("Kepler Plus layer types",
https://docs.ubica.dev/plus/assistant), whose tests check every key against the layers' code,
and the layer pages at https://docs.ubica.dev/plus/layers/. If a key here disagrees with a
working dashboard or the current docs, they win.

## Writing a Plus layer

Like any layer in `config.visState.layers[]`:
`{"id","type","config":{"dataId":"grafana-<refId>","label","columns","columnMode","isVisible":true,"visConfig":{...},"textLabel":[...]},"visualChannels":{...}}`.
kepler never adds these types by itself.

- Point-based types (gauge, prism, coverage, surface, sparkline, callout, fleet, model4d, floorplan):
  `"columns":{"lat":"latitude","lng":"longitude"}`, `"columnMode":"points"`.
- Colour: `visualChannels.colorField = {"name":"<col>","type":"real"|"integer"|"string"}` plus
  `visConfig.colorRange`. Thresholds: `"colorScale":"custom"` and
  `colorRange {"name":"..","type":"custom","category":"Custom","colors":[...],"colorMap":[[70,"#73BF69"],[90,"#FF9830"],[null,"#E02F44"]]}`
  (each number is the upper bound of its colour; `null` = the rest). String status:
  `"colorScale":"customOrdinal"`, `colorMap [["fault","#E02F44"],["moving","#73BF69"]]`.
  Grafana field thresholds do not apply.
- `textLabel[0].field = {"name":"<string column>","type":"string"}` names the mark.
- `rowsPerPlace`: `all` | `last` (default) | `min` | `max` (gauge, prism, coverage).
  `rowsAsset`: `auto` or a column naming a moving asset. Asset columns detected: vehicle_id,
  asset_id, device_id, imei, mmsi, icao24, callsign, unit_id, serial, drone_id, animal_id,
  collar_id, then trip_id, track_id.
- `historyField`: `color` (default) | `off` | a numeric column: the series in the popup
  (gauge, prism, coverage, traffic, pipeline).

## The eleven types

What is marked "Plus after 1.6.0" is on Plus main, not in the 1.6.0 release: check the Plus
version the instance runs before using it.

**gauge**: a ring or filling marker per point; `colorField` is both value and colour.
`gaugeShape` ring|thermometer|tank|battery|drop|icon (`gaugeIcon`), `gaugeMin` (0),
`gaugeMax` (`auto` = 1 if every value ≤ 1, else 100), `gaugeTextMode` percent|value,
`gaugeUnit`, `gaugeCentreText`, `gaugeTextSize`, `gaugeTextColor`, `radius` (22),
`gaugeThickness` (4), `gaugePosition` center|above|right|below|left with `gaugeDistance`,
`gaugeUpright`, `gaugeOnTop` (true: over the base map groups moved to the top, roads and labels,
and over the other layers), `gaugeBackground*`, `gaugeZoomScale`/`gaugeZoomRef`/`gaugeZoomRate`.
For: utilisation, levels, temperatures, renewable share. Example: `germany-power-borders`.

**prism** (3D Shape): a solid per point. `heightField`/`widthField`/`lengthField` (with
`heightScale: "linear"`), `colorField`, `angleField`, `labelField`; `prismShape`
box|cylinder|hexagon|triangle, `prismUnits` px|m, `prismWidth|Length|Height`,
`prism<Dim>Mode` scaled|raw, `prism<Dim>Multiplier`, `prism<Dim>Range`, `prismSquareBase`,
`prismAngle`, `prismLabel*`. Set `mapState.pitch` ~45, `dragRotate: true`.

**coverage**: a sector per row. `azimuthField`, `beamwidthField` (>360 = circle),
`reachField` + `reachScale`; fixed `coverageAzimuth`, `coverageBeamwidth` (65),
`coverageRange` (m, 1000); `coverageRangeMode`, `coverageInner`, `coverageGradient`,
`coverageOutline*`, `coverageSite*`; 3D: `coverage3d`, `coverageProfile` dome|cone,
`coverageHeight*`, `coverageDetail`. A mast with three sectors = three rows.
Examples: `caltrans-la-cameras`, `agi-hq-grid-cameras`.

**surface**: bands and isolines between points. `surfaceMode` interpolate (IDW of
`colorField`) | count (assets within `surfaceRadius` m); `surfaceReduce` last|mean|min|max,
`surfaceBands`, `surfaceIsolines*`, `surfaceLabels*`, `surfaceResolution`, `surfacePower` (2),
`surfaceMaxDistance`, `surfaceExtent` hull|rectangle, `surfaceMargin`, `surfaceBreaks`
("2, 5, 10": fixed breaks keep frames comparable while playing), `surfaceUnderBuildings` (true:
drawn inside the base map under its 3D buildings, on styles that have them such as
`openfreemap-liberty`; not with Relief), `surfaceDrape` (true: with a `tile3d` layer
on the map, laid over the ground of its tiles, buildings standing through it; flat otherwise),
`surfaceAltitude` (metres above the ground, 0). Example: `air-quality-amsterdam`.

**sparkline**: a card per place with its series. Needs time (`sparkTimeField` auto);
`colorField` is the plotted value. `sparkScale` common|perSite, `sparkMin|Max`, `sparkUnit`,
`sparkSize` S|M|L, `sparkCards` auto|hover, `sparkOverlap`, `sparkDots`, `sparkDotsOnTop` (true:
the dots over the base map's top groups, as the cards always are), `sparkAlerts` +
`sparkNoDataAfter`, `sparkCrosshair` (follows `cursorSync`). Example: `germany-power-borders`,
`melbourne-city-sensors`. Plus after 1.6.0: the cards of several card layers on one map keep off each
other, the layer higher in the list first.

**callout** ("3D Callout", Plus after 1.6.0): a sparkline whose cards stand on a vertical stem above
their places, the way a 3D map labels summits or a building's sensors. Same rows, keys and `spark*`
settings as sparkline, plus `"columns":{"lat","lng","altitude"}`: the height is the altitude column
plus `calloutLift` (m), on `calloutBase` column (as it is) | ground | surface (the ground, or the
roof or canopy, under the place in a `tile3d` layer on the map; 0 without one). `calloutStem`
(shortest stem, px, 36); cards climb to clear each other. `calloutAlertLabel` (`auto` = the label
named like the id column, `""` = none): a firing Grafana alert whose label holds a place's id keeps
its callout on top with the rule's name in red; it needs the panel's `alerts.show` and
`alerts.entityLabel` set to the same label (only placed alerts reach the layers).

**traffic**: animated links. `"columns":{"lat0","lng0","lat1","lng1"}`, `"columnMode":"points"`.
`colorField`, `sizeField`, `speedField` and their `reverse*` twins; `trafficDirectionMode`
straight|lanes|split, `trafficLaneBend`, `trafficShape` flat|arc, `trafficArcHeight`,
`trafficStyle` comets|dashes|dots|pulse, `trafficAnimate`, `trafficLapsRange`, `trafficCycle`,
`trafficTrail`, `trafficGlow`. Link queries (source/target, node graph) get a dataset
`grafana-LINKS-<refId>`. Examples: `germany-power-borders`, `datacenter-interconnection`.

**pipeline**: the traffic animation along a real route. `"columns":{"geojson":"<geometry col>"}`,
`"columnMode":"geojson"`. Colour is `strokeColorField` (+ `strokeColorScale`,
`visConfig.strokeColorRange`), **not** `colorField`. `sizeField`, `speedField`,
`altitudeField`, `pipelineLaneGap`, `pipelineAltitude`, `pipelineReverse`,
`pipelineSignedSpeed`. Example: `nyc-skyline-plus` (subway floating over buildings). Plus after
1.6.0: a line whose vertices change height (a riser, a pipe up a level) draws with its width facing
the screen; before, it drew nothing.

**fleet**: each asset once, where it is now, with a trail. Needs an asset and a time column.
- `fleetAssetField` / `fleetTimeField`: **set both explicitly** when the frame has other
  string columns (`auto` once picked a low-cardinality column and joined thousands of assets
  into scribbles).
- `fleetHeadingField`, `fleetSpeedField`, `fleetTypeField`, `fleetAltitudeField`.
- `fleetTimeRef`: `live` (now = wall clock; keep the range ending at now, or "now" becomes the
  end of the data) | `history` (replays: now = end of data or of the time window).
- `fleetStaleAfter` (5 min), `fleetRemember` + `fleetRememberMin` (keep pings between refreshes,
  GTFS-RT), `fleetStatusFrom`, `fleetStopSpeed`, `fleetHeadingFrom`.
- Trail: `fleetTrail` (min), `fleetTrailShow|Width|Opacity|Fade|Animate|Style`,
  `fleetTrailMode` fleet|trips (`fleetTripsTrail` h, `fleetTripsGap` h).
- Marker: `fleetMarker` silhouette|arrow|icon, `fleetDisplay` flat|3d, `fleetModelColours`,
  `fleetSize`, `fleetSmooth`, `fleetReckon` (live: a moving asset keeps going between refreshes
  at its last course, climb and speed; aircraft, ships), `fleetLabel` none|name|name+age.
  `fleetIcons` is a JSON **string** keyed by the type column
  (`"{\"bus\":{\"silhouette\":\"bus\"}}"`).
- Card: `fleetCard`, `fleetCardWindow`, `fleetCardSize`, `fleetSpeedUnit`, `fleetCrosshair`,
  `fleetCardField` + `fleetCardUnit`. A card's chart needs ≥ 2 readings in its window.
  `fleetPinned` lists the pinned assets' ids; `fleetPinAll: true` keeps every card open instead
  (one asset picked by a variable, whose id no saved pin can know: `tropical-cyclones`).
- Camera: `fleetFollow` (id, name or `"$variable"`), `fleetFollowMode`
  follow|orbit|chase|custom. A "vehicle cam" = a second Fleet map with `fleetFollow: "$vehicle"`.
  `fleetFollowFirst: true` with `fleetFollow` empty follows the layer's first asset. Follow, orbit
  and chase zoom in to street level from far out: for a storm or anything seen from afar use custom.
- Trails do not break at the antimeridian: unwrap longitudes per asset in SQL (cumulative
  ±360 on jumps > 180), then shift so the newest point is in [-180, 180].
- Indoors (Plus after 1.6.0): positions in a building's frame (`model_x`, `model_y`, `model_z`,
  `model_heading`; see "Data in a model's frame" below) with `fleetAltitudeField: "altitude"`,
  `fleetDisplay: "3d"`, `fleetStem: false`, `fleetTimeRef: "history"` for a replay, and the 4D
  Model's `opacity` under 1, or it hides the assets inside it.
- Examples: live `gtfs-rt-mbta-fleet`, `trimet-live-fleet`, `air-traffic-world`; replay
  `f1-race-laps`, `drone-delivery-flights`.

**model4d** ("4D Model", Plus after 1.5.0): a glTF model whose parts are built in time (BIM 4D).
One row per part: an id column naming a node of the model (an IFC GlobalId), start and finish
timestamps, and the model's origin in `latitude`/`longitude` on every row.
- `modelUrl`: an `https://` address the browser can fetch, or a file of the plugin; a path such as
  `/datasets/...` is refused (the map says "model URL is refused" and draws nothing). A model built
  on the instance is served by the gateway at `/datasets/<name>/<file>.glb`: name it by the
  instance's public address, `https://<host>/datasets/<name>/<file>.glb`. `modelIdField`, `modelStartField`,
  `modelFinishField` (`auto` or a column; auto start includes `time`), `modelHeading` (degrees
  clockwise from north), `modelAltitude` (m).
- The instant is the end of a time filter on the start column (a Time Brush through
  `timeSync: variables`, the filter's `view: side`), else the dashboard's end. A part is future
  (`modelFuture` ghost|hide), active (`modelActiveColour`) or built (`modelBuiltColour` model |
  layer: `colorField` with `customOrdinal`). `modelUnscheduled`: draw parts no row names.
- The SQL's start column named `time`, a TIMESTAMP, is what the panel's time filter and the
  layer's auto both find.
- State mode (`modelMode: "state"`, Plus after 1.6.0): rows are readings (id, time, values,
  origin), any number per part; each part takes `colorField`'s colour of its latest reading at
  or before the instant (custom thresholds or `customOrdinal`), so a Time Brush replays the asset
  and the dashboard's end shows it now. `modelTimeField` (`auto`: time, ts, timestamp…;
  `none`: every row current, a part's last row wins), `modelNoReading` ghost|hide,
  `modelStaleMinutes` (a reading older than this counts as none; 0 never). Start, finish,
  `modelBuiltColour` and `modelActiveColour` are ignored. Up to 256 named parts each hovers with
  its own row; above, parts of one colour draw as one mesh and do not hover. A Time Brush with
  `followLatest: true` keeps a live map on the newest reading until someone brushes back.
- `opacity` under 1 (Plus after 1.6.0) draws the model see-through, writing no depth: what stands
  inside it (Fleet assets on a floor, a callout's anchor, a room) shows. Opaque, it hides them.
- Example: `schependomlaan-4d` (model and schedule from `datasets/schependomlaan/build.sh`): Chaski
  datasets, the Time Brush (incremental, smooth) in the Mosaic Selection `build` on `time`, and Mosaic
  cards, Gantt and S-curve that read the instant as the latest day kept (`max`/`argmax` over a daily
  table, a `ruleX` at `{ max: time }`). The map follows the brush through `timeSync: variables`.

**floorplan** ("Floor plan", Plus after 1.6.0): a picture per row (an architect's plan, a scanned
evacuation map, a CAD export) laid flat on the map or on its floor. `image_url` (an `https://`
picture or a file of the plugin; any other URL is refused) and where it lies: `corners` (JSON
`[[lng,lat] ×4]`: bottom left, top left, top right, bottom right), or the row's latitude/longitude as
its centre with `width_m`, `depth_m` and `rotation` (degrees clockwise from north). visConfig
`planWhite` (0–1, default 0.8: pixels lighter than this turn transparent, so the paper is
see-through; 1 keeps it). Altitude column `floor_z` lifts it to its floor. With Floors on, the
Indoor tab makes this layer on the `grafana-floorplans` dataset, one row per plan: write one by hand
only for pictures Floors does not place.

## Cards on other layers (Plus after 1.6.0)

gauge, prism, coverage, traffic, pipeline and model4d take a card per object (a site, a sector, a
link, a pipe, a part) with its reading at the map's instant and its series, instead of kepler's
popup or always, from the same query: no sparkline layer beside them. visConfig:
- `cardShow` `tooltip` (default: kepler's popup, saved maps unchanged) | `hover` (a card instead of
  the popup, pinnable; pins in `cardPinned`) | `always`.
- `cardPlacement` `beside` | `above` (on a stem; model4d's default, at each part's top).
- `cardValueField` `color` (the colour field, when numeric) or a numeric column; `cardTimeField`
  `auto` | `none` (value only) | a column; `cardNameField`, `cardUnit`, `cardSize` S|M|L,
  `cardScale` common|perSite, `cardMin`/`cardMax` (`auto` or a number).
- `cardAlertLabel` (`""` = none): with the panel's `alerts.show` and `alerts.entityLabel` set to the
  same label, a firing alert whose label holds an object's value (in the column of that name, else
  the object's key) marks its card on top with the rule's name in red; with `cardShow: "hover"` it
  shows without a hover while the alert fires.
- Anchors: a gauge's or a sector's site; a prism's top when `prismUnits` is `m` (its base in px);
  halfway along a link, or along a pipeline at its height there (a riser's card halfway up); a
  model4d part's top, once the model has loaded.
- A 4D Model in State mode gives each part its colour and its card from one query.
- The free panel 1.7.0, which Plus builds on, renames a column `flow` (also `trips`, `weight`,
  `total`, `volume`) to `count` on every query: a card, stroke or colour field named `flow` reads
  nothing; name it otherwise (`airflow`). Free main renames it only on an origin–destination query;
  Plus keeps the old behaviour until it is built on a free release with that fix.

## Data in a model's frame (Plus after 1.6.0)

Any query on a map with a model4d layer can be written in the model's own coordinates instead of
latitude and longitude. Columns, by these exact names:
- `model_x`, `model_y`: metres east and north of the model's origin, before `modelHeading` turns
  it; `model_z`: metres up (optional). Coordinates read off a glTF file (Y up, −Z north): x, −z, y.
- `model_part`: a node name of the model; the row stands on the top of that part, centred on its
  footprint, `model_x/y/z` offsetting it. Placed once the model has loaded.
- `model_heading` (optional): degrees clockwise from the model's north; becomes `heading`.
- `model_geometry` (optional): GeoJSON in the model's metres, `[x, y]` or `[x, y, z]` (DuckDB
  `ST_AsGeoJSON` of local-metre geometry); becomes `geometry` for kepler's geojson layer (rooms:
  polygons at their floor's z, `enable3d` with a height field) and pipeline (pipes with z).
- `model` (optional): which model4d layer, by label or id; else the map's first.

The rows gain `latitude`, `longitude`, `altitude` (replacing columns of those names) before any
layer, Places or Alerts read them: set the layer's columns to `latitude`, `longitude` and, in 3D,
`altitude`. They follow the model when its Heading or Altitude change, before a save. A row whose
part is unknown or not loaded yet is drawn nowhere. Alerts with `entityLabel` are placed on these
rows too.

Minimal gauge layer:

```json
{"id":"sites","type":"gauge","config":{"dataId":"grafana-A","label":"Sites",
 "columns":{"lat":"latitude","lng":"longitude"},"columnMode":"points","isVisible":true,
 "visConfig":{"radius":30,"gaugeMax":100,"gaugeTextMode":"value","gaugeUnit":"%",
   "colorRange":{"name":"Load","type":"custom","category":"Custom","colors":["#73BF69","#FF9830","#E02F44"],
                 "colorMap":[[70,"#73BF69"],[90,"#FF9830"],[null,"#E02F44"]]}},
 "textLabel":[{"field":{"name":"site","type":"string"},"size":18,"color":[242,246,249],"offset":[0,40],
   "anchor":"middle","alignment":"center","outlineWidth":1,"outlineColor":[24,27,31,255],
   "background":false,"backgroundColor":[0,0,200,255]}]},
 "visualChannels":{"colorField":{"name":"Value","type":"real"},"colorScale":"custom"}}
```

## Floors: indoor maps (Plus after 1.6.0)

The panel option `floors` (beside `places` and `alerts`, not in `mapConfig`) turns a map into an
indoor map: a lift-panel picker over the map, the map narrowed to the floor picked, the floors
stacked in 3D. Docs: https://docs.ubica.dev/plus/indoor/. Copy from the app's own
`plus-tour-indoor` (an office with plans, rooms and callouts; a plant as a 4D model on two floors).

```json
"floors": {"enabled": true, "field": "level", "nameField": "floor_name", "variable": "floor",
  "defaultFloor": "0", "spacing": 6, "others": "ghost", "ghostOpacity": 0.12,
  "selectVariable": "room", "selectField": "room",
  "badge": {"field": "co2_ppm", "agg": "max", "warn": 1000, "alert": 1400, "label": "ppm CO2 at worst"}}
```

- The floor column (`field`; auto: level, ordinal, floor, level_ordinal, floor_number, floor_no,
  storey, story, etage, piso, nivel) holds a number (an IMDF ordinal: 0 ground, -1 basement), an OSM
  list `"0;1"` (the row shows on each, standing on the lowest) or span `"-1-2"`, or a name (`"G"`:
  listed after the numbers, never stacked). Give floors numbers and their names in `nameField`
  (auto: floor_name, level_name, floor_label, level_label, storey_name).
- `variable`: written by the picker and followed (a dropdown, a link `var-floor=2`, another panel);
  empty = every floor. `defaultFloor`: the floor it opens on. `mode` only|below. `zoomToFloor`
  (default true): picking a floor flies to it. A click mapping from the floor column to the floor
  variable picks a clicked room's floor.
- Stacking: `spacing` metres between floors (0 = all on the ground), `floorSettings` by floor id
  `{label, height, hidden, linked: [keys shown with it]}`, `groundFloor` level (floor 0 on the
  ground, basements under the map) | picked | lowest. `others` hide|outline|ghost (ghost needs a
  spread and keeps only shapes, not points), `ghostOpacity` (0.15), `above` zoom|keep|hide.
- `queryFloors` by refId: `follow` (default for a query with the floor column), `always` (every
  floor, each at its height), `["0"]` (only while one of these floors is picked: the site with the
  ground floor), `facade` (a building's shell: the other buildings, and zoomed out). A query without
  the floor column draws on every floor unless set.
- Every query that follows the floor is lifted: GeoJSON/WKT/WKB at its floor's height (kepler's
  geojson layer, `enable3d` with a height field for rooms as boxes); points gain `floor_z` (the
  floor's height + 0.25 m): set `columns.altitude = "floor_z"` on point, icon, gauge, prism,
  sparkline and callout, and `fleetAltitudeField: "floor_z"` with `fleetDisplay: "3d"` on fleet.
  `floor_h` (floor to next floor) as a height field raises a shaft or a full wall. Surface finds its
  floor by itself.
- `badge {field, agg sum|max|avg, label, warn, alert}`: the figure per floor on the picker and
  each building's card; counts every row the queries return (return each room's latest reading for
  a "now" figure).
- Buildings: `buildingField` (auto: building, building_id, building_name, structure, facility,
  edificio, bloque); floor ids become `<building>/<level>` (`""` for rows naming none).
  `buildingSettings` by building id `{label, base (m, up a hill), defaultFloor}`, `otherBuildings`
  default|all|hide, `buildingVariable`, `siteField` (auto: site, site_name, campus, city, region,
  sede, ciudad). Below `minZoom` (indoor zoom, default 17; 0 = always indoors; `outdoorZoom` half a
  level lower) every building shows its default floor (or facade) with a card; a breadcrumb over the
  map goes back out.
- Selection: `selectVariable` names a row by `selectField` (auto: code, id, room, room_name,
  sensor, sensor_id, asset, name; exact, case-sensitive match, and the row must have the floor
  column) or a place `@lat,lon[,zoom]`: the map goes to its building and floor, flies to it and
  rings it. A table link `/d/<uid>?${__url_time_range}&var-room=${__data.fields.room}` makes a
  finder.
- Plans: `plans` by floor id, an `https://` picture, a file of the plugin, or an uploaded data URL
  (≤ 1 MB); placed by `planPoints` (≥ 3 `{u, v, longitude, latitude}`, u/v shares of the picture
  from its top left), else at `planAnchor {latitude, longitude, widthM, rotation}`, else over the
  floor's rows. Rows with `plan_x`/`plan_y` (and the floor column) stand on the plan, in
  `planUnits` pixels|fraction|metres. Draw them with a `floorplan` layer on `grafana-floorplans`.
- Rooms traced on a plan (`planRooms`) or drawn on the map (`mapRooms`), floors added by hand
  (`declaredFloors [{level, building?, name}]`) and drawn (`floorOutlines`) are written by the Indoor
  tab's editors: do not hand-write them. `planRoomsData {refId, field}` gives the rooms a query's
  readings by room name; `planWalls {height}`. Their datasets: `grafana-planrooms`,
  `grafana-planwalls`, `grafana-flooroutlines`.

## Places and Alerts (panel options)

- `places`: `{"<refId>": {column, kind, colourBy, output, country, state}}`, all optional.
  `kind`: region | airport | country | ip | geohash | state | district | auto | off.
  `colourBy`: `{"op":"count"|"sum"|"avg","field":"<col>"}`. `output`: `choropleth` | `points`.
- `alerts`: `{"show": true, "states": ["firing","pending"], "filter": "team=sre", "folders": [...], "sources": [...], "placeLabel": "auto",
  "entityLabel": "vehicle_id", "entityField": "vehicle", "zones": true, "zoneLabel": "fence", "zoneField": "fence"}`.
  `show` must be true. Alerts are placed by their labels (coordinates, geohash, region, airport, country, site…).
  Geofences (Plus main, not released yet): `entityLabel` puts an alert on the latest position of the entity it names in
  the panel's own data (`entityField` column, default the label's name) and follows it on every refresh; `zones`
  (default on) draws each rule's `geofence` annotation (GeoJSON or WKT) under the other layers, red firing, amber
  pending, blue quiet; `zoneLabel` colours each fence by the alerts that name it, and draws every row of the panel's
  data with a geometry and the `zoneField` column (fences from PostGIS) as a zone. A geofence rule on any data
  source: query id, lat, lon; a SQL expression (`"format": "alerting"`, the condition itself) testing each row
  against the polygon's edges by ray casting (no `ST_` functions there). Name the map's id column anything but
  `vehicle_id`/`trip_id`: the free panel reads those as a trip id and renames them.
  Cards and callouts (Plus after 1.6.0): `cardAlertLabel` / `calloutAlertLabel` with `entityLabel` set
  to the same label mark the card of the entity an alert names.

## Plus base maps

`config.mapStyle.styleType`: `plus-azure-road|dark-grey|imagery|hybrid` and
`plus-google-roadmap|satellite|hybrid|terrain`. Each needs its provider's key in the app
config (both kept on the server). Since Plus 1.4.0 there are no `plus-maptiler-*` or
`plus-esri-*` styles: a map saved on one falls back to the free default with a notice, so use
the keyless `openfreemap-*` ids (or `grafana-satellite`) instead. Plus also has no
`cartoApiKey` option. Relief is a toggle, not a base map:
`config.mapStyle.visibleLayerGroups.relief = true` (Azure styles; on free styles use
`grafana-satellite-terrain` or `grafana-topographic-terrain`). Never invent a `*-relief` id. Google Photorealistic 3D tiles: the
"3D (Plus)" tab of Add Data (`tile3d` layer, `agi-hq-grid-cameras`).
