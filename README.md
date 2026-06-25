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

## Adding a new quarter

1. Download the new quarter's workbook(s) from FLOIR
   (https://floir.gov/tools-and-data/residential-market-share-reports) and drop
   the `.xlsx` file(s) **into this folder** (the same folder as this README).
   Both file types are supported:
   - `*_by_company_and_policy_type_*` (the rich file — TIV, wind, flows, claims)
   - `*_by_company_and_commercial_personal_*` (company-level summary)
2. Double-click **`update.bat`**.

That re-runs the ETL over *all* `.xlsx` files in the folder and reopens the site.
No code changes are needed — new policy types and companies are auto-discovered,
and the time axis extends automatically. If two files cover the same quarter, the
one with the newest pull-timestamp in its filename wins.

## What gets generated

- `web/data.js` — the normalized dataset the site loads (rebuildable; kept in
  git so the site works wherever the vault syncs).
- `validation_report.txt` — per-quarter coverage, Total-row checksums (body sum
  vs. published total), suppressed-cell counts, unrecognized policy types, and
  any warnings. **Check this after adding a quarter.**

## Under the hood

- `etl/ingest.py` — defensive parser. Maps columns by **header text** (not
  position, because column counts drift across quarters), keys the quarter off the
  filename, keeps NAIC as a string, treats a literal `.` as suppressed (never 0),
  detects and excludes the `Total` footer row (and uses it as a checksum).
- `web/index.html` + `web/app.js` — the static frontend (Plotly is vendored in
  `web/vendor/` so it works offline).

Requires Python with `pandas`/`openpyxl` available (only `openpyxl` is strictly
used). Rebuild anytime with `python etl\ingest.py`.
