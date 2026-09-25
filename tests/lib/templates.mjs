// The dashboard templates, read the way the tests need them.
import { readFileSync } from 'node:fs';

const asset = (name) => readFileSync(new URL(`../../skills/build-dashboard/assets/${name}`, import.meta.url), 'utf8');

export function brushHistogramBody() {
  return asset('brush-histogram.js');
}

// The template with its constants block replaced, as a dashboard carries it.
export function withConstants(body, constants) {
  return body.replace(/\/\/ @constants begin[\s\S]*?\/\/ @constants end/, `// @constants begin\n${constants.trim()}\n// @constants end`);
}

// The two parts of area-filter.sql, with the area variable replaced by an SQL
// expression (a string literal in tests, `$quakeArea` in the dashboard).
export function areaFilter(areaSqlExpr) {
  const text = asset('area-filter.sql');
  const part = (marker) => {
    const start = text.indexOf(`-- @${marker}`);
    const end = text.indexOf('-- @', start + 1);
    return text.slice(text.indexOf('\n', start) + 1, end === -1 ? undefined : end).trim().replaceAll('$quakeArea', areaSqlExpr);
  };
  return { cte: part('cte'), predicate: part('predicate') };
}
