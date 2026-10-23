// A filter bar for Business Text (renderMode "data"): the dashboard's active
// filters as chips, a × on each to clear it, "Clear all", and how many rows
// the filters leave.
//
// Two query frames feed it, both from Chaski:
//   FILTERS: SELECT name, label, value, variables, active FROM $__filters($quakeFilters)
//   COUNT:   SELECT count(*) FILTER (WHERE $__crossfilter($quakeFilters))::DOUBLE AS shown,
//                   count(*) FILTER (WHERE $__crossfilter($quakeFilters, -time))::DOUBLE AS without_time,
//                   count(*)::DOUBLE AS total FROM $quakes WHERE $__timeFilter(time)
// A `without_<name>` column hides that filter's chip while it removes no rows: a kepler
// map publishes its whole time window on load, which is active but narrows nothing.
// A chip's × empties its filter's variables; "Clear all" empties every one.
// Text goes in with textContent only: a variable's value is never markup.
//
// The panel's content is <div class="fbar"></div>; styles in filter-bar.css.
// A dashboard changes only the constants block below.
// @constants begin
const FILTERS = 'filters';
const COUNT = 'count';
const NOUN = 'rows';
const HINT = 'No filter yet.';
// @constants end

const frames = context.panelData.series;
const frame = (ref) => frames.find((f) => f.refId === ref);
const column = (f, name) => (f && f.fields.find((x) => x.name === name)?.values) || [];
const filters = frame(FILTERS);
const rows = Array.from(column(filters, 'label'), (label, i) => ({
  name: column(filters, 'name')[i],
  label,
  value: column(filters, 'value')[i],
  active: Boolean(column(filters, 'active')[i]),
  vars: String(column(filters, 'variables')[i] || '').split(',').filter(Boolean),
}));
const count = frame(COUNT);
const shown = column(count, 'shown')[0];
const total = column(count, 'total')[0];
const fmt = (n) => (n === undefined ? '…' : Number(n).toLocaleString('en-US'));
const clear = (vars) =>
  context.grafana.locationService.partial(Object.fromEntries(vars.map((v) => ['var-' + v, ''])), true);

const box = context.element.querySelector('.fbar');
if (!box) {
  return;
}
box.replaceChildren();
const add = (parent, tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  parent.appendChild(el);
  return el;
};
add(box, 'span', 'fbar-count', `${fmt(shown)} of ${fmt(total)} ${NOUN}`);
// Active, and narrowing: a filter with a `without_<name>` count equal to `shown` removes nothing.
const narrows = (r) => {
  const without = column(count, `without_${r.name}`)[0];
  return without === undefined || without !== shown;
};
const on = rows.filter((r) => r.active && narrows(r));
if (on.length === 0) {
  add(box, 'span', 'fbar-hint', HINT);
}
for (const r of on) {
  const chip = add(box, 'span', 'fbar-chip');
  add(chip, 'b', '', r.label);
  add(chip, 'span', '', r.value);
  const x = add(chip, 'button', '', '×');
  x.type = 'button';
  x.title = `Clear ${r.label}`;
  x.onclick = () => clear(r.vars);
}
if (on.length > 0) {
  const all = add(box, 'button', 'fbar-clear', 'Clear all');
  all.type = 'button';
  all.onclick = () => clear(rows.flatMap((r) => r.vars));
}
