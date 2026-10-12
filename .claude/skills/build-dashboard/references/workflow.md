# Workflow: SQL, preview, screenshots, tests, commit

Commands assume the repo root, Node 22 (`npx -y -p node@22 node …` with an older system node)
and `STACK_URL` set to where the gateway answers, e.g.
`export STACK_URL=http://127.0.0.1:$(docker compose port gateway 80 | cut -d: -f2)`.
How your host runs docker or node, and your instance's public URL, belong in
`CLAUDE.local.md`.

## Run SQL on the server DuckDB

The same engine, extensions and limits as the dashboards, through Grafana:

```bash
node --env-file=.env --input-type=module -e "
import { duckdb } from './tests/lib/grafana.mjs';
console.table(await duckdb(process.env.STACK_URL, \`DESCRIBE SELECT * FROM read_parquet('https://…')\`));
"
```

For anything longer than a line, write the SQL to a file in your scratchpad and
`readFileSync` it: no shell quoting. Always `--env-file=.env` (rule in AGENTS.md: without it,
failed admin logins lock the account).

Discovery before shaping (step 3 of the skill):

```sql
DESCRIBE SELECT * FROM <source>;
SUMMARIZE SELECT * FROM <source>;                      -- min, max, nulls, distinct per column
SELECT count(*), min(time), max(time),
       min(latitude), max(latitude), min(longitude), max(longitude),
       count(*) FILTER (WHERE latitude IS NULL) AS no_position
FROM <source>;
```

Then one magnitude check against a figure you know, e.g. the trip count a paper reports, a
country's area with `ST_Area_Spheroid`, the number of buses a city runs. Write the expected
figure down before you run it.

A Chaski query runs in the browser only: test it in the dashboard, or with the
`chaski(sql)` helper of `tests/lib/browser.mjs` on an open page.

## Preview a dashboard

With `PACHA_REPO_TYPE=local`, writing the file is the preview: Grafana picks it up within a
minute (`$STACK_URL/d/<uid>`). With `PACHA_REPO_TYPE=github`, a file reaches Grafana only once
pushed, and a push is live; show the work first with a temporary copy:

1. Create a non-synced folder named for the work, e.g. `tmp-<topic>`. A distinct name per
   piece of work: a shared generic folder gets deleted by someone else's cleanup.
   `POST /api/folders {"uid":"tmp-<topic>","title":"…"}`. If the people who must see it are
   not logged in, also `POST /api/folders/<uid>/permissions` giving Viewer *View* (anonymous
   access must be on, as it is by default in this stack).
2. Import the dashboard with its **real uid**, refusing if the uid already exists:
   `POST /apis/dashboard.grafana.app/v2/namespaces/default/dashboards` with
   `metadata.annotations["grafana.app/folder"] = "tmp-<topic>"`. Never into `plus` or
   `gallery`: those are Git Sync's and write the repository.
3. Give the user `<GF_SERVER_ROOT_URL>/d/<uid>`.
4. After the push (or if dropped): `DELETE` the dashboard, then the folder.

Use `api()` from `tests/lib/grafana.mjs` with the `.env` admin credentials for all of these.
Changing an existing dashboard: preview a copy of its latest version with only your panels
changed.

## Look at it

Screenshots need Chromium. The reliable way here is the Playwright container:

```bash
docker run --rm --network host --shm-size=2g -v "$PWD:/repo" -w /repo --env-file .env \
  -e STACK_URL mcr.microsoft.com/playwright:v1.63.0-noble \
  timeout -s INT 300 node <script.mjs>
```

- `--shm-size=2g`, or Chromium crashes on heavy Kepler maps.
- `timeout -s INT`: `node --test` there passes but hangs on exit.
- `openDashboard(path, {datasets, chaski})` from `tests/lib/browser.mjs` waits for the panels and
  the Chaski loads. Scroll each panel into view (Grafana renders lazily), wait for the map to
  settle, `page.screenshot`.
- Collect what failed: panel error icons (hover them for the message), `console` errors,
  `window.__duckdbwasm` stats.
- Then **read the images**. Check: the map is centred on the data, the layers are the ones
  configured (not the automatic fallback with its default palette), the colours mean what the
  legend says, no chart is empty, no panel shows an error, text fits.

Put throwaway scripts in your scratchpad, not in `tests/lib/`.

## Tests

Each dashboard has `tests/stack/<uid>.test.mjs`. Keep a new one to a handful of tests:

- conventions: uid = file name, description, tags with an engine, folder;
- each dataset or query returns sane rows (shape, ranges, counts), via `duckdb()` on the SQL
  taken from the file (`loadDashboard`, `panelTitled`, `datasetSql` in `tests/lib/dashboards.mjs`);
- feeds it uses are routed through the gateway, and cached;
- it opens with no panel in error (`openDashboard`).

Plus dashboards skip when Plus is not mounted (`provisioned.status === 404`). The smallest
example: `tests/stack/agi-hq-grid-cameras.test.mjs`. Run one file:

```bash
docker run --rm --network host --shm-size=2g -v "$PWD:/repo" -w /repo --env-file .env \
  -e STACK_URL -e COMPOSE_PROJECT_NAME=pacha \
  -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro \
  -v /usr/libexec/docker/cli-plugins:/usr/libexec/docker/cli-plugins:ro \
  mcr.microsoft.com/playwright:v1.63.0-noble timeout -s INT 600 node --test tests/stack/<uid>.test.mjs
```

A test that needs the dashboard provisioned can run against the preview copy (same uid); only
"is provisioned in <folder>" fails there.

`npm run test:templates` checks the assets in this skill.

## Commit and push

On a GitHub-synced instance, only after the user approves the preview.

1. Do every slow step first (delete the preview, run the tests).
2. Pull; if the dashboard has a newer save (Git Sync commits saves as "Save dashboard: …"),
   merge your panels onto it.
3. Stage only your own files and hunks and commit them in the same command
   (`git add <files> && git commit -m "feat: …"`), so nothing someone else staged rides along.
   If others have uncommitted work in the tree, commit from a temporary `git worktree`.
4. Push, then `git show HEAD:<file>` to check what landed. Never force-push.
5. Git Sync applies a change in about 25–60 s. Open the dashboard once to confirm.

## When the stack itself changes

- A new feed: a `location` in `gateway/feeds.conf`, checked with
  `docker compose run --rm --no-deps -T gateway nginx -t` before the gateway is restarted (ask
  first on a shared instance).
- A new dataset: `datasets/<name>/build.sh` + `build.sql`; every instance must run it.
- A panel plugin change belongs in that plugin's repository, not here.
