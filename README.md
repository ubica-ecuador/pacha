# Grafana Geospatial Stack

Cloud-native geospatial dashboards in Grafana, in one command. The stack bakes in:

- the [Kepler map panel](https://github.com/ubica-ecuador/keplergl-grafana-panel);
- [Chaski](https://github.com/ubica-ecuador/chaski), DuckDB in the browser;
- DuckDB and Infinity on the server;
- Business Charts, Business Table and Business Variable.

A TiTiler serves the imagery.

> Not affiliated with Grafana Labs.

## Run it

```bash
docker compose up --wait
```

Open <http://localhost:3000>. Anonymous visitors can view; sign in as `admin` / `admin` to edit (set
`GF_SECURITY_ADMIN_PASSWORD` in `.env`, starting from `.env.example`). Is port 3000 taken? Run
`STACK_PORT=3100 docker compose up --wait`. When the stack is reached under another host name (not localhost), set `GF_SERVER_ROOT_URL` in `.env` to that URL — Grafana Live checks browser origins against it.

## What runs

| Service   | What it does                                     | Reached at                        |
|-----------|--------------------------------------------------|-----------------------------------|
| `gateway` | nginx; the only published port                   | `:3000`                           |
| `grafana` | Grafana 13.2.1 with the plugins baked in         | `/`                               |
| `titiler` | Tiles for COG, Zarr and Icechunk                 | `/titiler/`                       |
| `mcp`     | [mcp-grafana](https://github.com/grafana/mcp-grafana) for AI agents | `http://127.0.0.1:8000/mcp`, `Authorization: Bearer $GEOSTACK_MCP_TOKEN` |

Plugins and DuckDB's extensions are part of the image, so nothing is downloaded when the stack
starts. The dashboards read their data where it is published.

## Working on the Kepler panel

```bash
KEPLER_DIST=../kepler-grafana/dist docker compose -f compose.yaml -f compose.dev.yaml up --wait
```

## Tests

```bash
npm ci && npx playwright install chromium
npm run test:config
docker compose build && npm run test:images
docker compose up --wait && npm run test:stack
```
