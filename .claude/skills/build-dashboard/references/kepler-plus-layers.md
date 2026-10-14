# Kepler Plus: layers, Places, Alerts, base maps

From the Plus app's Grafana Assistant skill ("Kepler Plus layer types",
https://docs.ubica.dev/plus/assistant), whose tests check every key against the layers' code,
and the layer pages at https://docs.ubica.dev/plus/layers/. If a key here disagrees with a
working dashboard or the current docs, they win.

## Writing a Plus layer

Like any layer in `config.visState.layers[]`:
`{"id","type","config":{"dataId":"grafana-<refId>","label","columns","columnMode","isVisible":true,"visConfig":{...},"textLabel":[...]},"visualChannels":{...}}`.
kepler never adds these types by itself.

- Point-based types (gauge, prism, coverage, surface, sparkline, fleet):
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

## The eight types

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
`openfreemap-liberty` or MapTiler's; not with Relief), `surfaceDrape` (true: with a `tile3d` layer
on the map, laid over the ground of its tiles, buildings standing through it; flat otherwise),
`surfaceAltitude` (metres above the ground, 0). Example: `air-quality-amsterdam`.

**sparkline**: a card per place with its series. Needs time (`sparkTimeField` auto);
`colorField` is the plotted value. `sparkScale` common|perSite, `sparkMin|Max`, `sparkUnit`,
`sparkSize` S|M|L, `sparkCards` auto|hover, `sparkOverlap`, `sparkDots`, `sparkDotsOnTop` (true:
the dots over the base map's top groups, as the cards always are), `sparkAlerts` +
`sparkNoDataAfter`, `sparkCrosshair` (follows `cursorSync`). Example: `germany-power-borders`,
`melbourne-city-sensors`.

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
`pipelineSignedSpeed`. Example: `nyc-skyline-plus` (subway floating over buildings).

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
- Camera: `fleetFollow` (id, name or `"$variable"`), `fleetFollowMode`
  follow|orbit|chase|custom. A "vehicle cam" = a second Fleet map with `fleetFollow: "$vehicle"`.
- Trails do not break at the antimeridian: unwrap longitudes per asset in SQL (cumulative
  ±360 on jumps > 180), then shift so the newest point is in [-180, 180].
- Examples: live `gtfs-rt-mbta-fleet`, `trimet-live-fleet`, `air-traffic-world`; replay
  `f1-race-laps`, `drone-delivery-flights`.

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

## Places and Alerts (panel options)

- `places`: `{"<refId>": {column, kind, colourBy, output, country, state}}`, all optional.
  `kind`: region | airport | country | ip | geohash | state | district | auto | off.
  `colourBy`: `{"op":"count"|"sum"|"avg","field":"<col>"}`. `output`: `choropleth` | `points`.
- `alerts`: `{"show": true, "states": ["firing","pending"], "filter": "team=sre", "folders": [...], "sources": [...], "placeLabel": "auto"}`.
  `show` must be true.

## Plus base maps

`config.mapStyle.styleType`: `plus-maptiler-*` (streets, streets-dark, outdoor, topo, winter,
dataviz, dataviz-dark, satellite, hybrid), `plus-esri-*` (navigation, navigation-night,
streets, topographic, outdoor, light-gray, dark-gray, imagery), `plus-azure-*`,
`plus-google-roadmap|satellite|hybrid|terrain`. Each needs its provider's key in the app
config. Relief is a toggle, not a base map: `config.mapStyle.visibleLayerGroups.relief = true`
(MapTiler, Esri, Azure). Never invent a `*-relief` id. Google Photorealistic 3D tiles: the
"3D (Plus)" tab of Add Data (`tile3d` layer, `agi-hq-grid-cameras`).
