# Dashboards

Every dashboard here is synced with Grafana by Git Sync. A save in Grafana,
from the UI or from an agent through MCP, writes the file. In dev it shows up
in `git status`; on a public instance it is a commit on `main`. A change to a
file (an edit, `git pull`, a branch switch) reaches Grafana within about a
minute: Grafana polls the files, and in practice runs a sync every 25 to 60 s
even though dev asks for 10.

## Folders

One directory per folder. Its `_folder.json` holds the folder's uid and title.

| Folder     | Directory                 | Holds                                  |
|------------|---------------------------|----------------------------------------|
| Gallery    | `gallery/`                | examples on the free stack             |
| Plus       | `../plus/dashboards/`     | what needs Kepler Plus; only with the Plus overlay |

## Tags

A closed vocabulary. Add a theme tag in the same change as the dashboard that
needs it; the other facets change only with the stack.

- **Engine, at least one:** `chaski` (queries in the browser), `duckdb`
  (queries on the server), `infinity` (reads HTTP or JSON).
- **Visualization:** `kepler`, `business-charts`,
  `business-table`, `business-text`.
- **Theme and behaviour:** `seismic`, `mobility`, `transit`, `energy`,
  `air-quality`, `gps`, `weather`, `migration`, `maritime`, `aviation`, `live`
  (feeds that reload by themselves).

Every Plus dashboard carries `plus`: filter what needs Plus with it.

## Conventions

1. The file name is the dashboard's uid (`metadata.name`), in kebab-case.
2. The description is never empty: it is what the list and search show.
3. Tags come from the vocabulary above and include at least one engine.
4. Datasources are referenced by their provisioned uid only: `duckdb`,
   `infinity`, `duckdbwasm` (Chaski). That is what makes a dashboard work on
   every environment.
5. Files are in Grafana's own format: keys sorted, two-space indent, `<` `>`
   `&` escaped, no trailing newline. A file edited by hand may drift; Grafana
   rewrites it on the next save, once.
6. A title says what the dashboard shows. Engines and plugins go in tags.

## Backlog

Showcase dashboards still to build, each its own piece of work:

1. **GFS forecast with TiTiler.** NOAA's forecast, which TiTiler preloads from
   Icechunk, as map tiles, with per-area statistics computed in DuckDB.
2. **Satellite scenes by STAC.** A STAC search through `http_client`, filtered
   by the time range; the scene on the map through TiTiler; band algebra with
   the `raster` extension.
3. **H3 over a large Parquet.** A public dataset too large for the browser,
   read remotely and aggregated into `h3` or `a5` cells on the server.
4. **An Iceberg table.** A public Iceberg table read with time travel between
   snapshots.
