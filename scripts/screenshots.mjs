// Screenshots for the home dashboard: home/screenshots/<uid>.jpg, a 16:9 crop
// of the first map panel of each dashboard, taken the way a visitor sees it.
// The home's cards look for /home/screenshots/<uid>.jpg and show a plain
// background when there is none, so a missing one is not an error.
//
// Needs Chromium and Node 22: run it in the Playwright container.
//
//   docker run --rm --network host --shm-size=2g -u "$(id -u):$(id -g)" -e HOME=/tmp \
//     -v "$PWD:/repo" -w /repo mcr.microsoft.com/playwright:v1.63.0-noble \
//     node scripts/screenshots.mjs --base https://pacha.ubica.dev [uid ...]
//
// --base URL     where the dashboards answer (default: STACK_URL). A base-map key
//                restricted by origin wants the public URL, not 127.0.0.1.
// --settle N     seconds to wait once every panel has loaded, for the map to
//                draw (default 30; software GL in headless Chromium is slow, and
//                a 3D city needs about 40).
// uid ...        which dashboards; none means every file in dashboards/gallery/
//                and plus/dashboards/.
//
// The viewport is tall on purpose: a map panel below the fold draws only its
// bottom strip in headless Chromium, whatever is resized later.
import { readdirSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const base = option('--base', process.env.STACK_URL ?? 'http://127.0.0.1:3000');
const settleMs = Number(option('--settle', '30')) * 1000;
const out = new URL('../home/screenshots/', import.meta.url);
mkdirSync(out, { recursive: true });

const everyUid = () =>
  ['dashboards/gallery', 'plus/dashboards']
    .flatMap((dir) => {
      try {
        return readdirSync(new URL(`../${dir}/`, import.meta.url));
      } catch {
        return [];
      }
    })
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -5))
    .sort();
const uids = args.length ? args : everyUid();

// The first Kepler map (a MapLibre canvas; a chart's canvas does not count),
// cropped to 16:9 below its panel header. None drawn: no screenshot.
const crop = (page) =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll('[data-viz-panel-key]')].find((el) => el.querySelector('.maplibregl-canvas, .mapboxgl-canvas'));
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    const header = 36;
    const bw = r.width;
    const bh = r.height - header;
    const [w, h] = bw / bh >= 16 / 9 ? [(bh * 16) / 9, bh] : [bw, (bw * 9) / 16];
    return { x: r.x + (bw - w) / 2, y: r.y + header, width: Math.round(w), height: Math.round(h) };
  });

const browser = await chromium.launch();
let failed = 0;
for (const uid of uids) {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1800 } });
  const page = await context.newPage();
  try {
    await page.goto(`/d/${uid}?kiosk`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-viz-panel-key]').length > 0 &&
        document.querySelectorAll('[aria-label="Panel loading bar"]').length === 0,
      null,
      { timeout: 150_000, polling: 250 },
    );
    await page.waitForTimeout(settleMs);
    const errors = await page.locator('[data-testid="data-testid Panel status error"]').count();
    const clip = await crop(page);
    if (!clip) {
      // A map that is not there yet (a plugin failing, a slow source) would
      // leave a misleading picture: better none, and the card's background.
      failed += 1;
      console.log(`${uid}: no map panel drawn${errors ? ` (${errors} panel(s) in error)` : ''}; nothing written`);
      await context.close();
      continue;
    }
    await page.screenshot({ path: new URL(`${uid}.jpg`, out).pathname, type: 'jpeg', quality: 76, clip, timeout: 120_000 });
    console.log(`${uid}: ok${errors ? ` (${errors} panel(s) in error)` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`${uid}: FAILED ${String(error).split('\n')[0].slice(0, 160)}`);
  }
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0); // explicit: node would otherwise hang on exit in the container
