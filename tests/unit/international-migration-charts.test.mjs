// The international-migration dashboard's two Business Charts, run from the
// file as Business Charts runs them: the body of a function of `context`, here
// with a fake chart and a fake Grafana.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';

const dashboard = loadDashboard('dashboards/gallery/international-migration.json');
const codeOf = (title) => panelTitled(dashboard, title).vizConfig.spec.options.getOption;

const frame = (columns) => ({
  refId: 'A',
  fields: Object.entries(columns).map(([name, values]) => ({ name, values })),
});

function run(title, series, vars = { country: '218', 'country:text': 'Ecuador' }) {
  const handlers = {};
  const partials = [];
  const chart = {
    on: (event, fn) => { handlers[event] = fn; },
    off: (event) => { delete handlers[event]; },
  };
  const context = {
    panel: { chart, data: { series } },
    grafana: {
      locationService: { partial: (query, replace) => partials.push({ query, replace }) },
      replaceVariables: (text) => text.replace(/\$\{([\w:]+)\}/g, (_, name) => vars[name] ?? ''),
      theme: { colors: { text: { primary: '#ccc', secondary: '#888' } } },
    },
  };
  const option = new Function('context', codeOf(title))(context);
  return { option, handlers, partials };
}

const corridors = frame({
  side: ['in', 'in', 'out', 'out'],
  code: ['862', '170', '840', '724'],
  name: ['Venezuela (Bolivarian Republic of)', 'Colombia', 'United States of America', 'Spain'],
  people: [474000, 192000, 525000, 418000],
  share: [56.1, 1.4, 41.2, 32.8],
});

test('the corridors chart links origins to the country and the country to destinations', () => {
  const { option } = run('Corridors in and out', [corridors]);
  const [sankey] = option.series;
  assert.equal(sankey.type, 'sankey');
  assert.deepEqual(
    sankey.links.map((l) => [l.source, l.target, l.value]),
    [['in:862', 'country', 474000], ['in:170', 'country', 192000], ['country', 'out:840', 525000], ['country', 'out:724', 418000]],
  );
  // Venezuela as an origin and Venezuela as a destination are two nodes.
  assert.deepEqual(sankey.data.map((n) => n.name).sort(), ['country', 'in:170', 'in:862', 'out:724', 'out:840']);
  assert.equal(sankey.label.formatter({ name: 'country' }), 'Ecuador');
  assert.equal(sankey.label.formatter({ name: 'out:724' }), 'Spain');
});

test('the corridors chart labels partners by short name, and only those with 2% of their side', () => {
  const { option } = run('Corridors in and out', [corridors]);
  const [sankey] = option.series;
  assert.equal(sankey.label.formatter({ name: 'in:862' }), 'Venezuela');
  const shown = (id) => sankey.data.find((n) => n.name === id).label.show;
  assert.equal(shown('in:862'), true);
  assert.equal(shown('in:170'), false);
  assert.equal(shown('country'), true);
  // The tooltip keeps the full name.
  assert.match(option.tooltip.formatter({ dataType: 'node', name: 'in:862' }), /Bolivarian/);
});

test('the corridors tooltip gives people and the share of that side', () => {
  const { option } = run('Corridors in and out', [corridors]);
  const tip = option.tooltip.formatter({ dataType: 'edge', data: option.series[0].links[2] });
  assert.match(tip, /Ecuador → United States of America/);
  assert.match(tip, /525k/);
  assert.match(tip, /41\.2%/);
});

test('a click on a partner in the corridors chart selects that country', () => {
  const { handlers, partials } = run('Corridors in and out', [corridors]);
  handlers.click({ dataType: 'node', name: 'out:724' });
  assert.deepEqual(partials, [{ query: { 'var-country': '724' }, replace: undefined }]);
});

test('a click on the country itself or on a link changes nothing', () => {
  const { handlers, partials } = run('Corridors in and out', [corridors]);
  handlers.click({ dataType: 'node', name: 'country' });
  handlers.click({ dataType: 'edge', data: { source: 'in:862', target: 'country' } });
  assert.deepEqual(partials, []);
});

test('with no corridor, the corridors chart says so instead of drawing', () => {
  const empty = frame({ side: [], code: [], name: [], people: [], share: [] });
  const { option } = run('Corridors in and out', [empty]);
  assert.deepEqual(option.series, []);
  assert.match(option.title.text, /No corridor/);
});

const pyramid = frame({
  Country: ['Venezuela (Bolivarian Republic of)', 'Colombia'],
  code: ['862', '170'],
  Men: [230000, 90000],
  Women: [244000, 102000],
});

test('the pyramid sets men to the left and women to the right, largest on top', () => {
  const { option } = run('Men and women by corridor', [pyramid]);
  const [men, women] = option.series;
  assert.deepEqual(men.data, [-230000, -90000]);
  assert.deepEqual(women.data, [244000, 102000]);
  assert.deepEqual(option.yAxis.data, ['Venezuela', 'Colombia']);
  assert.equal(option.yAxis.inverse, true);
  // The axis reads people, not signed numbers.
  assert.equal(option.xAxis.axisLabel.formatter(-230000), '230k');
});

test('the pyramid names corridors by short name, and in full in its tooltip', () => {
  const { option } = run('Men and women by corridor', [pyramid]);
  assert.deepEqual(option.yAxis.data, ['Venezuela', 'Colombia']);
  assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /Bolivarian/);
});

test('the pyramid labels each corridor with its share of women', () => {
  const { option } = run('Men and women by corridor', [pyramid]);
  const women = option.series[1];
  assert.equal(women.label.formatter({ dataIndex: 0 }), '51%');
});

test('a click on a bar of the pyramid selects that country', () => {
  const { handlers, partials } = run('Men and women by corridor', [pyramid]);
  handlers.click({ componentType: 'series', dataIndex: 1 });
  assert.deepEqual(partials, [{ query: { 'var-country': '170' }, replace: undefined }]);
});
