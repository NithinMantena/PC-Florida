# Florida P&C Market Explorer

Interactive explorer for the Florida residential P&C market, built from FLOIR
QUASR / Quarterly-MIR residential market-share workbooks. See `Florida_PC_PRD.md`
for the full spec.

## How to use it

Open **`web/index.html`** in any browser (double-click works — no server needed).

The left panel drives everything:

- **View** — *Ranking* (carriers ranked for one quarter), *Market share* (share of
  a metric within your slice), *Time series* (one-or-more carriers over time).
- **Metric** — PIF, TIV/exposure, direct premium written, policy flow (new /
  cancelled / nonrenewed / takeouts / hurricane-driven), claims, lawsuits, and
  derived metrics (⊕): net policy flow, avg premium/policy, rate-on-line (DPW/TIV),
  wind concentration.
- **Wind basis** — all / incl-wind / excl-wind (applies to PIF, TIV, DPW).
- **Line / policy types / wind-only** — slice to Commercial vs Personal, specific
  policy types, or wind-only products.
- **Companies** — multi-select for time series; search tolerates name changes
  (resolved by NAIC). Leave empty in Time-series to chart the whole filtered slice.
- **Display** — $ scaling, Top-N, and QoQ / YoY transforms (time series).

Every view shows its active filter context at the top and exports the current
table to CSV.

## Chatbot API / MCP server (Claude, ChatGPT, OpenClaw, ...)

The same dataset is served to LLMs by a hosted API: a Supabase Edge Function in the
(shared, free-tier) reading list project, with its own `flpc` Postgres schema. It
exposes 8 tools: catalog, company search, time series, period-over-period change
attribution, rankings/market share, company profile, market overview and read-only
SQL. Together they cover any company or group, metric, policy type and quarter, with
compact, token-cheap output. There are four ways in:

- **Remote MCP** `…/functions/v1/flpc/mcp`: Claude and ChatGPT connectors, Claude Code
- **REST + OpenAPI** `…/functions/v1/flpc/api/*`: Custom GPT Actions, scripts
- **Local MCP (stdio)**, `mcp/server.mjs` or the `pc-florida-mcp` Docker image: Claude Desktop config, Docker MCP Toolkit, local models
- **OpenClaw**: the `openclaw/skills/florida-pc` skill plus the `flpc` CLI

Setup: **[docs/SUPABASE.md](docs/SUPABASE.md)**. Connecting each client:
**[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**. How it works:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Tool reference and the self-hosted
Docker alternative (`api/`): **[docs/API.md](docs/API.md)**.

## Adding a new quarter

1. Download the new quarter's workbook(s) from FLOIR
   (https://floir.gov/tools-and-data/residential-market-share-reports) and drop
   the `.xlsx` file(s) **into this folder** (the same folder as this README).
   Both file types are supported:
   - `*_by_company_and_policy_type_*` (the rich file — TIV, wind, flows, claims)
   - `*_by_company_and_commercial_personal_*` (company-level summary)
2. Double-click **`update.bat`**.
3. Commit and push the new `.xlsx` (and `web/data.js`) to `main`. GitHub then
   reloads the hosted API's data automatically (see docs/SUPABASE.md).

`update.bat` re-runs the ETL over *all* `.xlsx` files in the folder and reopens the site.
No code changes are needed — new policy types and companies are auto-discovered,
and the time axis extends automatically. If two files cover the same quarter, the
one with the newest pull-timestamp in its filename wins.

## What gets generated

- `web/data.js` — the normalized dataset the site loads (rebuildable; kept in
  git so the site works wherever the vault syncs).
- `data/florida_pc.sqlite` — the same data as a SQLite store for the API / MCP
  server (gitignored; the server rebuilds it itself).
- `validation_report.txt` — per-quarter coverage, Total-row checksums (body sum
  vs. published total), suppressed-cell counts, unrecognized policy types, and
  any warnings. **Check this after adding a quarter.**

## Under the hood

- `etl/ingest.py` — defensive parser. Maps columns by **header text** (not
  position, because column counts drift across quarters), keys the quarter off the
  filename, keeps NAIC as a string, treats a literal `.` as suppressed (never 0),
  detects and excludes the `Total` footer row (and uses it as a checksum).
- `config/carrier_groups.csv` — editable NAIC → parent-group mapping used by the API.
- `supabase/` — the hosted API: database setup (`flpc.sql`) and the Edge Function
  (`functions/flpc`, logic in `functions/_shared/flpc/`), see docs/ARCHITECTURE.md.
- `client/`, `mcp/`, `openclaw/` — shared API client, local stdio MCP server, OpenClaw CLI and skill.
- `api/flpc/` — self-hosted Python query engine, MCP server and REST API (see docs/API.md).
- `web/index.html` + `web/app.js` — the static frontend (Plotly is vendored in
  `web/vendor/` so it works offline).

Requires Python with `pandas`/`openpyxl` available (only `openpyxl` is strictly
used). Rebuild anytime with `python etl\ingest.py`.
