---
name: florida-pc
description: Florida residential property & casualty insurance market data (FLOIR QUASR / Quarterly-MIR, 2022Q2 onward) by carrier, carrier group, line and policy type — policies in force, TIV/exposure, premium, new/cancelled/nonrenewed/takeout flows, claims, lawsuits. Use for market share, rankings, quarter-over-quarter changes, "who drove the change", and carrier profiles (Citizens, Universal, Heritage, American Integrity, Slide, Tower Hill, ...).
metadata: {"openclaw":{"emoji":"🌀","requires":{"bins":["flpc"]}}}
---

# Florida P&C market data

Query the hosted Florida P&C data API with the `flpc` command. It returns compact
CSV-style tables; dollar columns are scaled and the unit is in the header
(`tiv ($B)`). Every command is read-only.

## Workflow

1. Unsure what exists (metric ids, policy types, latest quarter)? Run `flpc get_catalog` once.
2. Company name → NAIC: `flpc find_companies --query "american integrity"`.
3. Pick the tool that answers in one call:

| Question | Command |
|---|---|
| Market headline for a quarter | `flpc market_overview [--period 2026Q1] [--line commercial]` |
| League table / market share | `flpc rank --metric tiv [--top_n 10] [--compare_to latest-4]` |
| Trend over quarters | `flpc timeseries --metrics tiv,pif [--group_by company] [--transform yoy]` |
| Who drove a change | `flpc compare_periods --metric pif --period_from latest-1 --period_to latest` |
| What drove one carrier's change | `flpc compare_periods --metric tiv --companies "Slide" --group_by policy_type` |
| One carrier or group, everything | `flpc company_profile --company Citizens` or `--group "Universal Insurance Holdings"` |
| Anything else | `flpc run_sql --query "select ... from facts ..."` (read-only Postgres) |

## Arguments

- Periods: `2026Q1`, `latest`, `latest-1` (prior quarter), `latest-4` (a year earlier).
- Filters on any aggregating tool: `--companies` (names or NAICs, comma-separated),
  `--groups`, `--exclude_companies Citizens` (private market), `--line commercial|personal`,
  `--policy_types p_ho,cmp` (ids or product families from the catalog), `--wind_only true|false`.
- `--group_by company|group|line|policy_type|product|wind_only` (up to 2, comma-separated).
- Complex arguments can be one JSON object instead: `flpc rank '{"metric":"dpw","extra_metrics":["pif","avg_premium"]}'`.
- `--json` returns JSON tables instead of CSV text. `flpc tools` lists every parameter.

## Reading results

- Stocks (pif, tiv, dpw, claims_pending) are as of quarter end; flows (new_written,
  cancelled, claims_opened, ...) are counts during the quarter.
- Ratios (avg_premium, premium_per_1k_tiv, ...) are ratio-of-sums and exclude tiny carriers.
- Suppressed FLOIR cells are excluded, never treated as zero; the output says when a slice has any.
- If a command fails, its message says what to change (e.g. "Did you mean ...", valid ids). Fix and rerun.

## Setup (once)

From a clone of the repository: `npm install -g .` (puts `flpc` on the PATH), then
`flpc config --url https://<project-ref>.supabase.co/functions/v1/flpc --token <read token>`
and check with `flpc health`. FLPC_URL / FLPC_TOKEN in the environment override the saved config.
