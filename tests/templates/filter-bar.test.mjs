// The filter bar template run as Business Text runs it: as the body of a
// function of `context`, here with a fake DOM and a fake Grafana.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterBarBody } from '../lib/templates.mjs';

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.textContent = '';
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    this.children = [];
  }
  querySelector(selector) {
    return selector === '.fbar' ? this.bar : null;
  }
  text() {
    return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(' ');
  }
}

const frame = (refId, columns) => ({
  refId,
  fields: Object.entries(columns).map(([name, values]) => ({ name, values })),
});

function run(filters, counts = { shown: [1521], total: [10105] }) {
  globalThis.document = { createElement: (tag) => new El(tag) };
  const element = new El('div');
  element.bar = new El('div');
  const partials = [];
  const context = {
    element,
    panelData: {
      series: [
        frame('filters', {
          name: filters.map((f) => f.name),
          label: filters.map((f) => f.label),
          value: filters.map((f) => f.value),
          variables: filters.map((f) => f.variables),
          active: filters.map((f) => f.active),
        }),
        frame('count', counts),
      ],
    },
    grafana: { locationService: { partial: (query, replace) => partials.push({ query, replace }) } },
  };
  new Function('context', filterBarBody())(context);
  return { bar: element.bar, partials };
}

const MAG = { name: 'mag', label: 'Magnitude', value: '2.5 – 6', variables: 'mag_lo,mag_hi', active: true };
const DEPTH = { name: 'depth', label: 'Depth', value: '0 – 70', variables: 'depth_lo,depth_hi', active: true };
const AREA = { name: 'area', label: 'Area', value: '', variables: 'area', active: false };

test('shows the count and a chip per active filter, and nothing for an inactive one', () => {
  const { bar } = run([MAG, DEPTH, AREA]);
  assert.equal(bar.text(), '1,521 of 10,105 rows Magnitude 2.5 – 6 × Depth 0 – 70 × Clear all');
});

test('shows the hint when no filter is active', () => {
  const { bar } = run([AREA]);
  assert.equal(bar.text(), '1,521 of 10,105 rows No filter yet.');
});

test("a chip's × empties its variables, and Clear all empties every filter's", () => {
  const { bar, partials } = run([MAG, DEPTH, AREA]);
  bar.children[1].children[2].onclick();
  bar.children.at(-1).onclick();
  assert.deepEqual(partials, [
    { query: { 'var-mag_lo': '', 'var-mag_hi': '' }, replace: true },
    { query: { 'var-mag_lo': '', 'var-mag_hi': '', 'var-depth_lo': '', 'var-depth_hi': '', 'var-area': '' }, replace: true },
  ]);
});

test('puts a value in as text, never as markup', () => {
  const { bar } = run([{ ...MAG, value: '<img src=x onerror=alert(1)>' }]);
  assert.equal(bar.children[1].children[1].textContent, '<img src=x onerror=alert(1)>');
});

test('hides an active filter that removes no rows, and shows it once it does', () => {
  const TIME = { name: 'time', label: 'Time', value: 'whole window', variables: 't0,t1', active: true };
  const quiet = run([TIME], { shown: [10105], without_time: [10105], total: [10105] });
  assert.equal(quiet.bar.text(), '10,105 of 10,105 rows No filter yet.');
  const narrowing = run([TIME, MAG], { shown: [800], without_time: [1521], total: [10105] });
  assert.equal(narrowing.bar.text(), '800 of 10,105 rows Time whole window × Magnitude 2.5 – 6 × Clear all');
});
