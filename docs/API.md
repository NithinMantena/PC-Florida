# Florida P&C Data API + MCP Server

One Docker container that serves the whole FLOIR dataset (every company, every
policy type, every metric, every quarter) to LLM chatbots and anything else:

| Path | What | Used by |
|------|------|---------|
| `/mcp` | MCP (streamable HTTP) | Claude connectors (web/desktop/mobile), ChatGPT connectors, Claude Code, any MCP client |
| `/api/*` | REST, JSON or compact text | ChatGPT Custom GPT Actions, scripts, n8n, dashboards |
| `/openapi.json` | OpenAPI 3.1 spec | Custom GPT "Import from URL" |
| `/health` | Health check (no auth) | Docker / monitoring |

`python -m flpc stdio` also speaks MCP over stdin/stdout (Claude Desktop launching
the container locally).

---

## 1. Deploy on your Docker server

```bash
git clone https://github.com/nithinmantena/pc-florida.git
cd pc-florida
cp .env.example .env              # set FLPC_API_KEY (and later FLPC_PUBLIC_URL)
mkdir -p incoming                 # drop new quarterly .xlsx files here
docker compose up -d --build
curl http://127.0.0.1:8000/health
```

If you already run a compose stack (or Portainer), paste the `pc-florida` service
from `docker-compose.yml` into it. It needs only one port and one volume.

Every push to `main` also publishes the image `ghcr.io/nithinmantena/pc-florida:latest`
(see `.github/workflows/ci.yml`). To pull it instead of building, replace `build: .` with
`image: ghcr.io/nithinmantena/pc-florida:latest` (private repo: `docker login ghcr.io`
first, using a GitHub token with `read:packages`).

### Adding a new quarter

Drop the new FLOIR workbook(s) into the mounted folder (`./incoming` by default).
The server checks the folder every 60 s, rebuilds its database, and serves the new
quarter. No restart or rebuild is needed. The quarters bundled in the image stay
available; if two files cover the same quarter, the newest pull-timestamp in the
filename wins. Commit the file to the repo too if you want future images to include it.
The container runs as uid 10001, so the files must be world-readable (the default
for copied files). If a rebuild fails, the server keeps serving the previous data
and reports the error in `/health` and `get_catalog`.

### Carrier groups

`config/carrier_groups.csv` maps NAIC codes to parent groups (Universal, HCI,
Tower Hill, USAA, Allstate, Chubb, ...). To override it without rebuilding, put an
edited `carrier_groups.csv` in the `incoming` folder. It is picked up like a new
workbook. Unmapped companies are their own standalone group.

### Updating the code

```bash
git pull && docker compose up -d --build
```

---

## 2. Public HTTPS with Tailscale Funnel

Claude and ChatGPT connect from their own clouds, so the server needs a public
HTTPS URL. Tailscale Funnel provides one without opening router ports.
First, allow Funnel in your tailnet policy: the admin console prompts you the first
time, or add the `funnel` node attribute.

**Option A: Tailscale already on the Docker host (simplest)**

```bash
sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8000
tailscale funnel status          # shows https://<host>.<tailnet>.ts.net:8443
```

Funnel allows ports 443, 8443 and 10000. Use `--https=443` if nothing else on the
host uses Funnel/Serve on 443.

**Option B: dedicated Tailscale sidecar** (its own node, e.g.
`https://pc-florida.<tailnet>.ts.net`): set `TS_AUTHKEY` in `.env`, then

```bash
docker compose -f docker-compose.tailscale.yml up -d --build
```

After either option, set `FLPC_PUBLIC_URL` in `.env` to the public URL and run
`docker compose up -d` again, so the OpenAPI spec advertises it.

### Authentication

Set `FLPC_API_KEY`. Every request except `/health`, `/` and the OpenAPI/docs pages
must present the key in one of these ways:

| How | Use for |
|-----|---------|
| `Authorization: Bearer <key>` | Custom GPT Actions, Claude Code, scripts |
| `X-API-Key: <key>` | scripts |
| `?key=<key>` | quick tests |
| URL prefix `/k/<key>/...`, e.g. `https://host/k/<key>/mcp` | Claude / ChatGPT connectors, which only take a URL |

The data itself is public FLOIR data. The key keeps strangers from using your
server. Rotate it by changing `FLPC_API_KEY` and running `docker compose up -d`.

---

## 3. Connect your chatbots

Below, `https://HOST` is your Funnel URL and `KEY` is `FLPC_API_KEY`.

**Claude (claude.ai, Desktop, mobile):** Settings → Connectors → *Add custom
connector* → URL `https://HOST/k/KEY/mcp`. Enable it in a chat from the tools menu.

**Claude Code:**
```bash
claude mcp add --transport http florida-pc https://HOST/mcp --header "Authorization: Bearer KEY"
```
Inside the tailnet you can use `http://<server>:8000/mcp` instead, if you publish
the port on a tailnet address (`FLPC_BIND`).

**Claude Desktop, fully local (no server):**
```json
{
  "mcpServers": {
    "florida-pc": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "/path/to/incoming:/data", "pc-florida", "stdio"]
    }
  }
}
```

**ChatGPT connector (developer mode / apps):** Settings → Apps & Connectors →
Advanced → enable Developer mode → *Create* → MCP server URL `https://HOST/k/KEY/mcp`,
authentication *None* (the key is in the URL).

**ChatGPT Custom GPT (Actions):** Configure → Actions → *Import from URL*
`https://HOST/openapi.json` → Authentication: *API Key*, *Bearer*, paste `KEY`. Suggested
instructions: *"Use getCatalog first. For trends use timeseries; to explain a change
use comparePeriods (by company, then with companies=[...] by policy_type)."*

These menu names change from time to time. The URLs and auth methods above are
what matter.

---

## 4. Tools

All tools share these filters: `companies`, `groups`, `exclude_companies` (names
or NAICs, fuzzy matched, name history aware), `line` (`commercial`|`personal`),
`policy_types` (ids like `c_cmp_condo_assoc`, product families like `cmp`/`ho`, or
id prefixes like `c_`), `wind_only`. Periods are `2026Q1`, `latest`, `latest-1`,
`latest-4`. Dollar columns are auto-scaled to $K/$M/$B, with the unit in the
header; pass `raw=true` for unscaled values.

| MCP tool | REST | Purpose |
|----------|------|---------|
| `get_catalog` | `GET /api/catalog` | Periods, all metric ids and definitions, policy-type ids, groups, syntax, caveats, workflow |
| `find_companies` | `POST /api/find_companies` | Name/former name/group/NAIC search → NAIC, group, active range, size, rank |
| `timeseries` | `POST /api/timeseries` | Metric(s) over quarters; optional `group_by` (company, group, line, policy_type, product, wind_only); transforms value/qoq/yoy/diff/share; top-N + "All others" + "Total" |
| `compare_periods` | `POST /api/compare_periods` | What drove a change between two quarters: rows sorted by absolute change with % change and **share of net change**, plus gross increases and decreases |
| `rank` | `POST /api/rank` | League table and market share for a quarter, optional change vs an earlier quarter, extra metric columns |
| `company_profile` | `POST /api/company_profile` | One-call carrier or group summary: key metrics with QoQ/YoY, rank and share, line split, policy-type mix, 8-quarter trend, members |
| `market_overview` | `POST /api/market_overview` | Quarter headline: totals with QoQ/YoY, commercial/personal split, top TIV/PIF movers, largest carriers |
| `run_sql` | `POST /api/sql` | Read-only SQL over the normalized tables (escape hatch) |

REST endpoints return JSON `{title, context, tables:[{columns, rows}], notes}`, or
compact text with `?format=text`.

**Metrics:**
- **Stocks:** `pif`, `tiv`, `dpw`, each also `_incl_wind` and `_excl_wind`.
- **Flows:** `new_written`, `received_in` (takeouts), `transferred_out`, `cancelled`,
  `cancelled_hurricane`, `nonrenewed`, `nonrenewed_hurricane`.
- **Claims (2023Q1 onward):** `claims_opened`, `claims_closed`, `claims_pending`,
  plus ADR / mediation / arbitration / appraisal counts.
- **Lawsuits (2026Q1 onward):** opened, closed, closed for consumer, open at start
  and at end of quarter.
- **Derived:** `net_flow`, `lapses`, `avg_premium`, `avg_tiv`, `premium_per_1k_tiv`,
  `wind_share_tiv`, `wind_share_pif`, `new_business_rate`, `cancel_rate`,
  `nonrenew_rate`, `claims_per_1k_pif`, `adr_rate`, `lawsuits_per_1k_claims`.

`get_catalog` lists them with definitions.

### Example drill-down (3 calls, about 1–2k tokens each)

```text
timeseries(metrics=["tiv"], line="commercial")
  -> sees commercial TIV jump in 2026Q2
compare_periods(metric="tiv", period_from="2026Q1", period_to="2026Q2", line="commercial")
  -> AMERICAN INTEGRITY is the top row, with its share_of_net_change_%
compare_periods(metric="tiv", period_from="2026Q1", period_to="2026Q2",
                companies=["American Integrity"], line="commercial", group_by="policy_type")
  -> which commercial policy types drove it
```

Sample output (a real 2025Q4 → 2026Q1 run):

```text
## TIV / exposure: 2025Q4 → 2026Q1 change by policy_type
filters: companies=AMERICAN INTEGRITY INSURANCE COMPANY OF FLORIDA (12841); line=commercial
sorted by absolute change

policy_type,2025Q4 ($B),2026Q1 ($B),change,change_%,share_of_net_change_%
c_condo_assoc_wind,7.809,10.35,2.544,32.6,86.0
c_allied_condo_assoc,0.09057,0.5031,0.4126,455.5,14.0
Total,7.9,10.86,2.956,37.4,100.0
```

---

## 5. Data notes

- The data comes from the Company × Policy Type workbooks: statewide Florida
  residential (personal and commercial residential) business, keyed by NAIC.
- Suppressed source cells (`.`) are excluded from sums, never counted as 0.
  Responses say when a slice contains any.
- Ratios are always computed as a ratio of sums.
- Growth % is blank when the base is ≤ 0.
- The Company × Commercial/Personal summary workbooks are loaded into the
  `summary_a` table (queryable via `run_sql`) for cross-checks.

## 6. Development

```bash
pip install -r api/requirements-dev.txt
python etl/ingest.py              # web/data.js + data/florida_pc.sqlite + validation report
pytest                            # engine, REST, MCP (HTTP + in-process client)
cd api && python -m flpc serve    # http://127.0.0.1:8000  (FLPC_API_KEY optional locally)
```

Environment variables: `FLPC_API_KEY`, `FLPC_PUBLIC_URL`, `FLPC_INPUT_DIRS` (folders
of .xlsx, `:` or `,` separated), `FLPC_DB`, `FLPC_GROUPS`, `FLPC_RELOAD_INTERVAL`
(seconds, default 60), `FLPC_HOST`, `FLPC_PORT`.
