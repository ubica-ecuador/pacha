// The histogram template run as Business Charts runs it: as the body of a
// function of `context`, here with a fake chart and a fake Grafana.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brushHistogramBody } from '../lib/templates.mjs';

const frame = (refId, bins, counts) => ({ refId, fields: [{ name: 'bin', values: bins }, { name: 'n', values: counts }] });

function run({ vars = {} } = {}) {
  const handlers = {};
  const actions = [];
  const partials = [];
  const chart = {
    on: (event, fn) => { handlers[event] = fn; },
    off: (event) => { delete handlers[event]; },
    dispatchAction: (action) => actions.push(action),
  };
  const context = {
    panel: { chart, data: { series: [frame('all', [4, 4.5, 5], [10, 6, 2]), frame('selected', [4.5], [3])] } },
    grafana: {
      locationService: { partial: (query, replace) => partials.push({ query, replace }) },
      replaceVariables: (text) => {
        const name = /^\$\{(\w+)\}$/.exec(text)?.[1];
        return name ? (vars[name] ?? '') : text;
      },
      theme: { visualization: { getColorByName: (name) => `color:${name}` }, colors: { text: { secondary: '#888' } } },
    },
  };
  const option = new Function('context', brushHistogramBody())(context);
  return { option, handlers, actions, partials };
}

test('draws all and selected rows as bars centred on their bins', () => {
  const { option } = run();
  const [all, selected] = option.series;
  assert.deepEqual(all.data, [[4.25, 10], [4.75, 6], [5.25, 2]]);
  assert.deepEqual(selected.data, [[4.75, 3]]);
  assert.equal(option.brush.brushType, 'lineX');
});

test('a finished brush publishes its range snapped to whole bins', () => {
  const { handlers, partials } = run();
  handlers.brushEnd({ areas: [{ coordRange: [4.2, 5.7] }] });
  assert.deepEqual(partials.at(-1), { query: { 'var-mag_lo': '4', 'var-mag_hi': '6' }, replace: true });
});

test('an empty brush clears both variables', () => {
  const { handlers, partials } = run();
  handlers.brushEnd({ areas: [] });
  assert.deepEqual(partials.at(-1), { query: { 'var-mag_lo': '', 'var-mag_hi': '' }, replace: true });
});

test('the clear button clears both variables', () => {
  const { handlers, partials } = run();
  handlers.brush({ command: 'clear' });
  assert.deepEqual(partials.at(-1), { query: { 'var-mag_lo': '', 'var-mag_hi': '' }, replace: true });
});

test('a range already in the variables is drawn back after a redraw', async () => {
  const { actions } = run({ vars: { mag_lo: '5', mag_hi: '6' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(actions.some((a) => a.type === 'brush' && a.areas?.[0]?.coordRange?.join() === '5,6'), JSON.stringify(actions));
});
