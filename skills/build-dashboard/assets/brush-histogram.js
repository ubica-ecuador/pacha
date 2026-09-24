// A histogram whose brush filters the rest of the dashboard.
//
// Dragging across it writes the selected range to two dashboard variables
// (LO and HI); the other panels filter on them, and this one does not, so it
// keeps showing the whole distribution the other filters leave. Two query
// frames feed it: `all` (grey, the context) and `selected` (colour, what the
// other filters leave). Each has columns `bin` (the bin's lower edge) and `n`.
//
// A dashboard changes only the constants block below.
// @constants begin
const LO = 'mag_lo';
const HI = 'mag_hi';
const STEP = 0.5;
const DOMAIN = [-1.5, 9];
const UNIT = 'magnitude';
const COLOR = 'orange';
// @constants end

const chart = context.panel.chart;
const location = context.grafana.locationService;
const theme = context.grafana.theme;

const points = (refId) => {
  const frame = context.panel.data.series.find((f) => f.refId === refId);
  if (!frame) {
    return [];
  }
  const bins = frame.fields.find((f) => f.name === 'bin').values;
  const counts = frame.fields.find((f) => f.name === 'n').values;
  return Array.from(bins, (b, i) => [Number(b) + STEP / 2, Number(counts[i])]);
};
const all = points('all');
const selected = points('selected');
const domain = DOMAIN || [Math.min(...all.map((p) => p[0] - STEP / 2)), Math.max(...all.map((p) => p[0] + STEP / 2))];

// Whole bins only: a range that cuts a bar in two would count half of it.
const snap = (range) => {
  const lo = Math.floor(range[0] / STEP) * STEP;
  const hi = Math.max(Math.ceil(range[1] / STEP) * STEP, lo + STEP);
  return [lo, hi];
};
const drawBrush = (range) =>
  chart.dispatchAction({ type: 'brush', areas: range ? [{ brushType: 'lineX', xAxisIndex: 0, coordRange: range }] : [] });
const publish = (range) => {
  location.partial({ ['var-' + LO]: range ? String(range[0]) : '', ['var-' + HI]: range ? String(range[1]) : '' }, true);
};

chart.off('brushEnd');
chart.off('brush');
chart.on('brushEnd', (event) => {
  const area = event.areas[0];
  if (!area || !area.coordRange) {
    publish(undefined);
    return;
  }
  const range = snap(area.coordRange);
  publish(range);
  setTimeout(() => drawBrush(range), 0);
});
chart.on('brush', (event) => {
  if (event.command === 'clear') {
    publish(undefined);
  }
});

// Every redraw (setOption without merge) wipes the brush: draw it back from
// the variables, which is also how a shared link arrives with its range.
const current = [
  parseFloat(context.grafana.replaceVariables('${' + LO + '}')),
  parseFloat(context.grafana.replaceVariables('${' + HI + '}')),
];
setTimeout(() => {
  chart.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
  if (current.every(Number.isFinite)) {
    drawBrush(current);
  }
}, 0);

const accent = theme.visualization.getColorByName(COLOR);
const muted = theme.colors.text.secondary;

return {
  animation: false,
  grid: { left: 8, right: 16, top: 30, bottom: 4, containLabel: true },
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'none' },
    formatter: (items) => {
      const x = items[0].value[0] - STEP / 2;
      const rows = items.map((it) => `${it.marker}${it.seriesName}: <b>${it.value[1]}</b>`).join('<br/>');
      return `${x}–${x + STEP} ${UNIT}<br/>${rows}`;
    },
  },
  toolbox: {
    right: 8,
    top: 0,
    itemSize: 14,
    feature: { brush: { type: ['lineX', 'clear'], title: { lineX: 'Select a range', clear: 'Clear the filter' } } },
  },
  brush: {
    xAxisIndex: 0,
    seriesIndex: [1],
    brushType: 'lineX',
    brushMode: 'single',
    transformable: true,
    brushStyle: { color: 'rgba(128, 128, 128, 0.12)', borderColor: muted, borderWidth: 1 },
    outOfBrush: { colorAlpha: 0.25 },
  },
  xAxis: { type: 'value', min: domain[0], max: domain[1], name: UNIT, nameGap: 4, axisLabel: { color: muted }, splitLine: { show: false } },
  yAxis: { type: 'value', axisLabel: { color: muted }, splitLine: { lineStyle: { opacity: 0.15 } } },
  series: [
    { name: 'All', type: 'bar', data: all, barWidth: '94%', silent: true, itemStyle: { color: 'rgba(128, 128, 128, 0.22)' } },
    { name: 'Filtered', type: 'bar', data: selected, barWidth: '94%', barGap: '-100%', itemStyle: { color: accent } },
  ],
};
