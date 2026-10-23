# Mosaic panels on Chaski

The Chaski app brings a second panel, **Chaski Mosaic** (`ubica-chaski-mosaic-panel`): Mosaic
(vgplot) specs drawn over the dashboard's Chaski datasets, with brushes that filter each other in
the browser and write dashboard variables. The part below the line is the Chaski app's Grafana
Assistant skill ("Mosaic panels on Chaski", `mosaicAuthoringSkill` in the Chaski repo's
`src/assistant/skills.ts`), whose tests parse its example as the panel does. The full guide is the
Chaski repo's `docs/mosaic.md`. If this file disagrees with a working dashboard, the dashboard wins.

## When to use it

- **Mosaic** for linked views over many rows (100 000 to millions): histograms that brush each
  other, rasters, density, contours, hexbins, regressions computed in DuckDB, with
  pre-aggregation so a brush answers in milliseconds. No JavaScript to maintain.
- **Business Charts** (`business-charts.md`) for a chart Mosaic does not draw (Sankey, pyramid,
  gauges), for styling it cannot do, or for one brush over a small frame
  (`assets/brush-histogram.js`).
- **kepler** for anything on a base map. Mosaic's geo marks have no tiles; pair them instead: kepler
  `viewportVariables` and `areaVariable` drive Mosaic through `reads`.

## Where to copy from

Four Grafana 13 (v2) dashboards in the Chaski repo's `examples/dashboards/`, synced read-only into
the **Chaski plugin** folder (rule 1: change them in the Chaski repo, never here or in Grafana):

| You need | Copy from |
|---|---|
| Histograms that brush each other and drive stat panels and a table through `$__crossfilter`; a live feed | `mosaic-gallery` (5 tabs: flights, Seattle weather, athletes, wind, USGS quakes) |
| Density, contours, heatmaps, 2-D brushes written as one range per axis | `mosaic-density` |
| Mosaic and a kepler map driving each other (viewport, drawn area) over a million rows | `mosaic-nyc-taxi` |
| A raster of 5 million points, rendering params shared by all panels | `mosaic-gaia` |

## In Pacha

- The Chaski datasource is `{"type": "ubica-chaski-datasource", "uid": "duckdbwasm"}` (rule 4);
  the skill below writes `<chaski uid>`.
- A Mosaic panel reads only Chaski datasets, which load in the viewer's browser: their URLs must
  allow CORS. `http://feeds/...` is not reachable from a browser; data that needs a key goes
  through the server DuckDB into a dataset with `source.type: datasource` (`engines.md`).
- Tests and screenshots: a Mosaic panel shows its own errors (test id `mosaic-error`), not
  Grafana's panel error state, so check both. It draws only after its datasets load; wait for
  `getByTestId('mosaic-panel').locator('svg')`, and for `svg rect` before dragging a brush. With
  a kepler map on the page, headless Chromium is slow: allow 20 s or more.

---

# Mosaic panels on Chaski
The Chaski Mosaic panel (type 'ubica-chaski-mosaic-panel') draws a Mosaic (vgplot) spec over the
dashboard's Chaski datasets: brush one chart and every Mosaic panel on the same selection filters in
the browser. It has no queries (targets stay empty); the dashboard needs at least one Chaski dataset.
Its options, all strings of YAML (or JSON) except the last:
- spec: a Mosaic spec (idl.uw.edu/mosaic/spec). Tables are datasets by bare name: data: { from:
  quakes, filterBy: $brush }. Never $quakes and never a qualified name such as explore.t.
- variables: writes. Each entry: param (a selection or param of the spec), column (the clause's
  column), then from/to for an interval, or variable for points (a multi-value variable), text, a
  param's value, or a 2-D brush over [longitude, latitude] (a WKT polygon). Any other 2-D brush
  writes one range per axis: column [x, y], from [x_lo, y_lo], to [x_hi, y_hi].
- reads: variables written elsewhere (a kepler map's viewportVariables or areaVariable, a picker)
  become clauses of a selection. Each entry: param, column, then from/to for a range, area for a WKT
  polygon over [longitude, latitude], or values for a multi-value variable. A panel cannot read a
  variable it writes; declare each read in one panel only.
- preaggregate: true (the default) builds small tables when a brush starts; keep it on.
Example panel:
{"type":"ubica-chaski-mosaic-panel","title":"Magnitude","gridPos":{"x":0,"y":0,"w":8,"h":8},"options":{"spec":"params:\n  brush: { select: crossfilter }\nplot:\n  - mark: rectY\n    data: { from: quakes, filterBy: $brush }\n    x: { bin: mag }\n    y: { count: }\n  - select: intervalX\n    as: $brush\nxDomain: Fixed\n","variables":"- param: brush\n  column: mag\n  from: mag_lo\n  to: mag_hi\n","reads":"","preaggregate":true}}
On a v2 dashboard the same options go in the element's vizConfig: { kind: 'VizConfig', group:
'ubica-chaski-mosaic-panel', spec: { options: {…}, fieldConfig: { defaults: {}, overrides: [] } } },
with data.spec.queries empty.
Linking with the rest of the dashboard:
- Params and selections are shared by name between all Mosaic panels of a dashboard; the first panel
  to define one sets its kind, so declare it the same way (params: brush: { select: crossfilter }) in
  every panel that uses it, and use one selection name per dataset.
- Written variables are hidden textbox variables (one per from, to or variable), never custom
  dropdowns: a custom variable defaults to its first option and would filter at load.
- Chaski SQL panels follow the brushes through a filters variable built on those same variables:
  a range filter per interval (from '$x_lo', to '$x_hi'), an area filter per WKT variable (only
  longitude and latitude: it wraps x at ±180), an in filter per points variable. Then SELECT count(*)
  FROM $quakes WHERE $__crossfilter($quakeFilters).
- A dataset's own SQL must not read a variable a Mosaic panel writes: each write would reload the
  dataset, and a reload clears every brush.
- To have a kepler map drive Mosaic, give the kepler panel viewportVariables {west, south, east,
  north} and areaVariable, and put reads in one Mosaic panel; the kepler query then leaves out the
  filters built on its own variables: $__crossfilter($f, -drawn, -view_lng, -view_lat).
Writing specs that work:
- Sizes: a single plot fills the panel; plots in a top-level vconcat or hconcat share it unless
  sized. Put a legend in its own vconcat item with for: <plot name>, or it spills out of the panel.
- Rasters, contours and heatmaps: use dark-ended schemes (magma, viridis, inferno) on a dark theme;
  blues and oranges start at white.
- Do not add a highlight interactor to aggregated marks (bins, counts) whose selection also filters
  other columns: their query fails with a DuckDB Binder Error.
- Names that are SQL keywords (lambda, order, group) must be renamed in the dataset's SQL.
- Inputs: menu, search, slider and table; geo marks take a projection but draw no base map (that is
  kepler's job).
- Mosaic's marks that compute in DuckDB (density, contours, heatmap, raster, hexbin, regression)
  scale to millions of rows; plain dot marks over millions of rows do not.
