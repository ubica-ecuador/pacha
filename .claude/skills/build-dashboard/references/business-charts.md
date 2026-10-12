# Business Charts (ECharts)

`volkovlabs-echarts-panel`, tag `business-charts`. It is the chart for anything over Chaski
frames: bars, lines, histograms with a brush, Sankey, pyramids, scatter. Native Grafana panels
are still right for stat, table and simple time series.

## Panel options

Code mode, no visual editor. Copy the whole `options` block from an existing panel and change
`getOption`:

```json
"options": {
  "editorMode": "code", "editor": { "format": "auto" }, "renderer": "canvas", "map": "none",
  "getOption": "<JavaScript, a function body that returns an ECharts option>",
  "themeEditor": { "config": "{}", "name": "default" },
  "visualEditor": { "code": "", "dataset": [], "series": [] },
  "baidu": {...}, "gaode": {...}, "google": {...}
}
```

The code is stored as one JSON string. Write it as a `.js` file first, check it reads well,
then embed it (`JSON.stringify`). Never hand-escape it.

## The code

What the function body sees:

| | |
|---|---|
| `context.panel.data.series` | the query frames; `frame.refId`, `frame.fields[i].name`, `.values` (array-like: `Array.from`) |
| `context.panel.chart` | the ECharts instance: `on`, `off`, `dispatchAction`, `getZr`, `convertFromPixel`, `setOption` |
| `context.grafana.theme` | `theme.colors.text.primary|secondary`, `theme.colors.border.weak`, `theme.visualization.getColorByName('orange')` |
| `context.grafana.replaceVariables('${var}')` | read a variable (`'${zone:text}'` for its label) |
| `context.grafana.locationService.partial({'var-x': v}, true)` | write a variable (replace history) |
| `context.grafana.eventBus` | publish `data-hover` to drive the shared crosshair by hand |

House style, from every chart here:

1. **A comment block first** that says what the chart shows and what clicking does.
2. **A `// @constants begin` … `// @constants end` block** with everything a dashboard changes:
   variable names, colours, units, steps. The rest of the code stays identical across
   dashboards, which is what makes it a template (`assets/brush-histogram.js`).
3. Read columns **by name**, never by position, and guard a missing frame:
   ```js
   const frame = context.panel.data.series.find((f) => f.refId === 'A');
   const col = (name) => (frame ? Array.from(frame.fields.find((f) => f.name === name)?.values ?? []) : []);
   ```
   Convert values with `Number(v)` (Chaski can hand BigInt-like or string values) and map
   `null` to `null`, not 0.
4. Colours from the theme for text and axes (`muted = theme.colors.text.secondary`); data colours
   **the same as the map's** for the same categories or breaks, so the chart is the map's legend.
   A context series in grey (`rgba(128,128,128,0.22)`) behind the selection in colour.
5. `animation: false`, `backgroundColor: 'transparent'`, `grid: {..., containLabel: true}`.
6. Before `chart.on(...)`, always `chart.off(...)` the same event: the code runs on every
   refresh and handlers pile up.
7. A category axis draws bottom up: `.reverse()` the arrays, or `inverse: true`, so the largest is
   on top.

## Recipes

**Click a bar to select, click again to clear** (`air-quality-amsterdam`):

```js
chart.off('click');
chart.on('click', (event) => {
  const id = ids[event.dataIndex];
  const same = id === context.grafana.replaceVariables('${' + VAR + '}');
  context.grafana.locationService.partial({ ['var-' + VAR]: same ? '' : id }, true);
});
```

Highlight the picked bar from the variable when drawing, so a shared link shows it too. Read it
as `'${' + VAR + '}'` *and* write the literal `${var}` somewhere in the code: the panel redraws
only when its code or query names the variable, and a name built from strings does not count.

**Brush a range into two variables**: `assets/brush-histogram.js`. Two frames, `all`
(context, grey) and `selected` (what the other filters leave), columns `bin` and `n`. The
histogram does not filter itself on its own range. Bins snap to whole steps; the brush is
redrawn from the variables after every refresh. Used in `earthquakes` (magnitude, depth).

**Legend toggles as a filter**: `chart.on('legendselectchanged', ...)` writing the selected
series to a variable (`animal-movement-tracking`, `nyc-taxi-trips`).

**Shared crosshair by hand** (`animal-movement-tracking`, `nyc-taxi-trips`): Business Charts does
not take part in Grafana's shared cursor. Publish on the event bus, tagged so the chart never
answers itself, rounded so the map is not re-asked on every pixel:

```js
const bus = context.grafana.eventBus;
const zr = chart.getZr();
zr.on('mousemove', (e) => {
  const ms = Math.round(chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])[0] / 3600000) * 3600000;
  bus.publish({ type: 'data-hover', payload: { point: { time: ms } }, tags: new Set([TAG]) });
});
zr.on('globalout', () => bus.publish({ type: 'data-hover-clear', payload: {}, tags: new Set([TAG]) }));
```

**Top N + other**: shape it in SQL (`ROW_NUMBER() ... CASE WHEN rn <= 7 THEN name ELSE 'Other' END`)
so the chart and the map share the same groups and palette.

**Sankey and pyramid**: `international-migration`. **Side-by-side shares against a total**:
`spain-daily-mobility`.

## Choosing the chart

Pick the chart for the question, not the data shape: a ranking is a horizontal bar, a
distribution a histogram, a share of a whole a stacked bar (not a pie with more than a few
slices), change over time a line, two measures against each other a scatter. Units in the axis
name or the tooltip, never missing. No rainbow palettes: a sequential ramp for an amount, a
diverging one around a meaningful middle, a few distinct hues for categories.
