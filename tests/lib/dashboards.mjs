// The dashboard files, read the way tests need them: by what they contain,
// whatever the v2 schema nests it under.
import { readFileSync } from 'node:fs';

export function loadDashboard(relativePath) {
  return JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}

export function findAll(node, match, found = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, match, found));
  } else if (node && typeof node === 'object') {
    if (match(node)) found.push(node);
    Object.values(node).forEach((child) => findAll(child, match, found));
  }
  return found;
}

export function datasetSql(dashboard, name) {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name && n.source);
  if (!query) throw new Error(`no Chaski dataset named ${name}`);
  return query.source.sql;
}

// Panels whose visualization is `pluginId`, under either the v1 `type` or the
// v2 `vizConfig.group` (per the Task 1 notes' "Panels" section).
export function panelsByType(dashboard, pluginId) {
  return findAll(dashboard, (n) => n.type === pluginId || n.vizConfig?.group === pluginId);
}

// A panel by its title, found under the v2 `Panel.spec` shape (`title` next to
// `vizConfig`) or the v1 shape (`title` next to `type`).
export function panelTitled(dashboard, title) {
  const [panel] = findAll(dashboard, (n) => n.title === title && (n.vizConfig || n.type));
  if (!panel) throw new Error(`no panel titled ${title}`);
  return panel;
}
