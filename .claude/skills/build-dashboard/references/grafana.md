# Grafana 13 dashboard JSON (v2)

Every dashboard is a resource:

```json
{
  "apiVersion": "dashboard.grafana.app/v2",
  "kind": "Dashboard",
  "metadata": { "name": "<uid = file name>", ... },
  "spec": {
    "title": "...", "description": "...", "tags": [...],
    "cursorSync": "Off" | "Crosshair" | "Tooltip",
    "timeSettings": { "from": "...", "to": "...", "timezone": "utc", ... },
    "variables": [ ... ],
    "elements": { "panel-<name>": { "kind": "Panel", "spec": { ... } } },
    "layout": { "kind": "GridLayout" | "RowsLayout" | "TabsLayout" | "AutoGridLayout", "spec": { ... } },
    "annotations": [...], "links": [...], "editable": true, "liveNow": false, "preload": false
  }
}
```

Some older files are still `v2beta1`; write new ones as `v2`. Read an existing file for the
exact keys rather than writing them from memory, and keep Grafana's format (keys sorted,
two-space indent, `<` `>` `&` escaped as `<` `>` `&`, no trailing newline).
After the first save in Grafana the file is rewritten in that format anyway.

## Panels

```json
"panel-daily": { "kind": "Panel", "spec": {
  "id": 8, "title": "...", "description": "...", "links": [],
  "data": { "kind": "QueryGroup", "spec": {
    "queries": [ { "kind": "PanelQuery", "spec": { "refId": "A", "hidden": false, "query": { <DataQuery> } } } ],
    "queryOptions": {}, "transformations": [] } },
  "vizConfig": { "kind": "VizConfig", "group": "<plugin id>", "version": "13.2.1",
    "spec": { "options": { ... }, "fieldConfig": { "defaults": {}, "overrides": [] } } } } }
```

Plugin ids in use: `ubica-keplerplus-panel`, `ubica-keplergl-panel`,
`volkovlabs-echarts-panel` (Business Charts), `volkovlabs-table-panel`,
`marcusolsson-dynamictext-panel`, and the native `stat`, `table`, `text`, `timeseries`,
`bargauge`, `xychart`, `trend`.

A text panel (`group: "text"`, `options.mode: "markdown"`) titled "About the data" says
where each source comes from, its licence, and how any derived figure is computed. Every
dashboard here has one.

**Say how fresh the data is, and where each figure comes from.** A reader must be able to
tell whether a number is from a minute ago or from last year, and how it was computed:

- Live or periodically updated sources: a small stat in the first row, "Latest data", with
  `SELECT max(time) AS time FROM $dataset` and the unit `dateTimeFromNow` ("3 minutes ago"),
  one per source when they update at different rates. A per-row "last seen" column in a table
  takes the same unit (`wildfires-power-grid`).
- Fixed or historical data: "About the data" states the period the data covers and when the
  source published it (or when `datasets/<name>/build.sh` built it).
- Every panel's description says what the figure is computed from, in a sentence: which
  dataset, which filter, which unit. The SQL itself is one click away in the query inspector;
  the description is for the reader who will not open it.

## Layouts

- `GridLayout` with `GridLayoutItem` `{element: {kind: "ElementReference", name}, x, y, width, height}`
  on a 24-column grid.
- `RowsLayout` → `RowsLayoutRow` (`title`, `collapse`, `layout`), and `TabsLayout` →
  `TabsLayoutTab` (`title`, `layout`). Long dashboards use tabs of rows
  (`geolife-mobility`: "1 · Cleaning", "2 · ...").
- **Conditional rendering** (show a row only when a variable is set) goes in
  `spec.conditionalRendering` of a `RowsLayoutRow`, `TabsLayoutTab` or `AutoGridLayoutItem`;
  **never** on a `GridLayoutItem`, where it is ignored.

```json
"conditionalRendering": { "kind": "ConditionalRenderingGroup", "spec": {
  "condition": "and", "visibility": "show",
  "items": [ { "kind": "ConditionalRenderingVariable", "spec": { "variable": "station", "operator": "equals", "value": "" } } ] } }
```

- Grafana renders panels lazily: a panel below the fold stays empty until scrolled into view.
  Tests and screenshots must scroll to it.

## Variables

- `QueryVariable`: Chaski datasets and value lists (see engines.md).
- `TextVariable`, hidden (`"hide": "hideVariable"`): what maps and charts write to. A map's
  click, area, time window, centre and brush ranges all land in text variables.
- `CustomVariable`: fixed choices (a year, a region).
- Variables that hold selections usually keep URL sync, so a shared link carries the selection.

**Selecting from a table** (where a map click cannot, e.g. a map with a Trip layer): a data
link on the table field that rewrites the URL:

```
/d/<uid>${__url.params:exclude:var-ships}&var-ships=${__data.fields.mmsi}
```

Add an "All …" row that clears the variable.

## Time

- Historical data: save an **absolute** UTC range that covers it
  (`"from": "2007-04-01T00:00:00.000Z"`, `"timezone": "utc"`), often with
  `"hideTimepicker": true`. A relative range like `now-6h` shows an empty map.
- Kepler's clock reads UTC: keep the dashboard in UTC.
- Live data: relative range ending at `now`, `autoRefresh` such as `"1m"`; tag `live`.
- `cursorSync: "Crosshair"` shares the crosshair, which Sparkline and Fleet cards follow.

## Tables

Grafana 13 tables keep a wide minimum column width, so a narrow table shows two columns and
scrolls: set `custom.minWidth` (~40) and a width per column in overrides. An image column:
cell type Image.
