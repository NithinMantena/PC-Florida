# Product Requirements Document — Florida P&C

**Project:** Florida P&C Market Explorer
**Owner:** Nithin (Alderran Capital)
**Audience for this doc:** Cursor / Claude (implementation agent)
**Status:** Draft v1.0
**Last updated:** June 25, 2026

---

## 1. Summary

Florida P&C is a web application for interactively exploring the Florida residential property & casualty insurance market. The underlying data comes from the Florida Office of Insurance Regulation (FLOIR) QUASR (Quarterly Aggregated Statewide Reporting) residential market-share reports, published every quarter at https://floir.gov/tools-and-data/residential-market-share-reports.

Each quarter FLOIR publishes Excel workbooks containing, for every insurer writing residential business in Florida, structured metrics on policies in force, exposure (TIV), and direct premium written, split by commercial vs. personal and by detailed policy type. The app ingests ~30+ of these quarterly files, normalizes them into a single time-series dataset, and lets the user slice the data any way they want: by company, by line of business, by policy type, by metric, and over time.

The goal is an analyst's tool — fast, flexible pivoting and charting over a clean longitudinal dataset — not a polished consumer product. Think "Bloomberg-lite for the Florida homeowners market."

### Primary user stories

- "Show me total dollar value of exposure (TIV) by carrier, this quarter, ranked." 
- "Show me TIV but only for commercial residential."
- "Show me market share across companies by direct premium written."
- "Plot American Coastal's TIV over time."
- "Plot Citizens' policies-in-force over the last 5 years."
- "Show me the wind-only exposure for a given carrier over time."
- "Compare two carriers' premium growth side by side."
- "Show me net policy flow (new written minus cancelled minus nonrenewed) for a carrier over time."

The unifying requirement: **the user can cut and splice the data however they want — by entity, by line, by metric, as a snapshot or as a time series.**

---

## 2. Data source

### 2.1 Origin
- Published by FLOIR at the URL above ("Residential Market Share Reports").
- New workbook(s) released each calendar quarter.
- Data is a statewide aggregation of insurer QUASR filings.
- Two distinct workbook *types* are published per quarter (see below). Both cover the same quarter and the same universe of companies but at different granularity.

### 2.2 The two file types

Nithin has provided 2022Q2 examples of both. **The parser must handle both layouts.** Roughly 30+ quarters of history exist; assume the schema is stable across quarters but **do not assume header rows or exact column wording are byte-identical** — build the parser defensively (see §4).

---

#### File Type A — "Company × Commercial/Personal Summary"
Example filename: `quasr_statewide_summary_by_company_and_commercial_personal_2022q2_*.xlsx`

- **Single sheet**, sheet name like `Ranked By Total PIF`.
- Rows 1–2: title + "Data pulled on …" timestamp (metadata, not data).
- **Header is on row 3** (1-indexed row 3; 0-indexed row 2).
- One row per company, pre-ranked by total policies in force.
- A **`Total` row at the very bottom** (must be detected and excluded from per-company analysis, but is useful as a validation checksum).

Columns (in order):

| # | Column | Notes |
|---|--------|-------|
| 0 | Rank by total number of policies in force | integer rank; blank on Total row |
| 1 | Company name | string; `"Total"` on the footer row |
| 2 | NAIC code | **string** — preserve as text, may matter for joins; can have leading characters; do not coerce to int |
| 3 | Total number of policies in force (as of quarter end) | int |
| 4 | Number of PIF that are commercial residential | int |
| 5 | Number of PIF that are personal residential | int |
| 6 | Total direct premium written for PIF | float (dollars) |
| 7 | Direct premium written — commercial residential | float |
| 8 | Direct premium written — personal residential | float |

Granularity: **company × {total, commercial, personal}**. No policy-type detail, no exposure/TIV, no wind split. Good for high-level market-share and commercial-vs-personal views.

---

#### File Type B — "Company × Policy Type Summary"
Example filename: `quasr_statewide_summary_by_company_and_policy_type_2022q2_*.xlsx`

- **Single sheet**, sheet name like `By Company then Policy Type`.
- Rows 1–2: title + timestamp.
- Row 3: blank.
- **Header is on row 4** (1-indexed; 0-indexed row 3). *Note the header row differs from File Type A.*
- One row per **company × policy type** (a company appears on multiple rows).
- A **`Total` row at the bottom**.

Columns (in order):

| # | Column | Notes |
|---|--------|-------|
| 0 | NAIC code | string |
| 1 | Company name | string |
| 2 | Policy type | string, e.g. `Personal Residential - Homeowners (Excl Tenant and Condo) - Owner Occupied`. This is the LOB dimension — see §2.3. |
| 3 | Total policies in force (PIF) | int |
| 4 | PIF excluding wind coverage | int |
| 5 | PIF including wind coverage | int |
| 6 | Policies cancelled in quarter | int |
| 7 | Policies cancelled due to hurricane risk | int |
| 8 | Policies nonrenewed in quarter | int |
| 9 | Policies nonrenewed due to hurricane risk | int |
| 10 | Policies transferred to other insurers | int |
| 11 | New policies written in quarter | int |
| 12 | Policies received from other insurers (takeout/assumption) | int |
| 13 | **Total dollar value of exposure (TIV)** | float (dollars) |
| 14 | TIV excluding wind coverage | float |
| 15 | TIV including wind coverage | float |
| 16 | Total direct premium written | float |
| 17 | Direct premium written excluding wind | float |
| 18 | Direct premium written including wind | float |

Granularity: **company × policy type**, with **wind-included / wind-excluded splits** and **policy-flow** metrics (cancels, nonrenewals, new business, takeouts). This is the richer file — it's where TIV/exposure lives, where the wind breakdown lives, and where churn/flow metrics live.

### 2.3 Policy type taxonomy (File Type B, col 2)

Each policy-type string encodes a **line** (Commercial Residential vs. Personal Residential) and a **product**. The app should parse these into structured dimensions so the user can filter on "Commercial" vs "Personal," on product, and on "wind only." Observed values in 2022Q2:

**Commercial Residential**
- Commercial Residential - Dwelling/Fire (Excl Condo Associations)
- Commercial Residential - Dwelling/Fire (Condo Associations Only)
- Commercial Residential - Allied Lines (Excl Condo Associations)
- Commercial Residential - Allied Lines (Condo Associations Only)
- Commercial Residential - CMP (Excl Condo Associations)
- Commercial Residential - CMP (Condo Associations Only)
- Commercial Residential - (Apartment Buildings) - WIND ONLY
- Commercial Residential - (Condo Associations Only) - WIND ONLY
- Commercial Residential - (Homeowners Association) - WIND ONLY

**Personal Residential**
- Personal Residential - Homeowners (Excl Tenant and Condo) - Owner Occupied
- Personal Residential - Homeowners (Excl Tenant and Condo) - Owner Occupied - WIND ONLY
- Personal Residential - Condominium Unit Owners
- Personal Residential - Condominium Unit Owners - WIND ONLY
- Personal Residential - Tenants
- Personal Residential - Tenants - WIND ONLY
- Personal Residential - Dwelling/Fire
- Personal Residential - Allied Lines
- Personal Residential - Allied Lines - WIND ONLY DWELLINGS
- Personal Residential - Mobile Homeowners
- Personal Residential - Mobile Homeowners - WIND ONLY
- Personal Residential - Dwelling/Fire - Mobile Homeowners
- Personal Residential - Dwelling/Fire - Mobile Homeowners - WIND ONLY
- Personal Residential - Farmowners

**Parsing rule:** derive `line` ∈ {Commercial Residential, Personal Residential} from the prefix; derive `is_wind_only` = string contains `WIND ONLY`; keep the full `policy_type` string as the leaf dimension. **Do not hardcode the list** — discover distinct values at ingest, because newer quarters may add/rename types. Surface any unrecognized prefix as a data-quality warning rather than silently dropping it.

### 2.4 Known data quirks (must handle)

These are observed in the sample files and **will** break a naive parser:

1. **Suppressed/masked cells appear as a literal `"."` (period)** in File Type B (e.g., Zurich American rows). Treat `"."` as null/redacted, not zero — distinguish "suppressed" from "actual zero" in the model and in display.
2. **The footer `Total` row** must be detected (Company name == "Total", or rank/NAIC blank) and excluded from entity-level rollups. Optionally retain it as a published-total checksum.
3. **Currency in the Total row may be a formatted string** with `$` and commas (e.g., `$3,098,225,107,375`) while body rows are plain floats. Strip non-numeric characters when parsing.
4. **NAIC code is the stable join key**, not company name. Company *names* change over time (mergers, rebrands — e.g., American Coastal's history). Treat NAIC code as the primary entity key and company name as a display label that can vary by quarter. Keep NAIC as a string.
5. **Header row differs between file types** (row 3 vs row 4) and rows 1–2 are always metadata. Detect the header row by scanning for the known anchor column (`Company name` / `NAIC`) rather than hardcoding an index.
6. **The "Data pulled on …" timestamp** in row 2 is metadata; capture it but the authoritative period is the reporting quarter (from filename / title), not the pull date.
7. **Float precision**: premiums often carry cents (e.g., `888268320.84`). Preserve full precision; round only at display time.
8. **A company may appear in File B but not File A** (or vice versa) if it only writes in lines that one report captures. Don't assume the company universe is identical across the two file types within a quarter.

### 2.5 Period / quarter identification
- The reporting quarter must be extracted reliably. Filename contains it (e.g., `…2022q2…`); the title row also states the date range (e.g., "4/1/2022-6/30/2022"). Prefer parsing the explicit date range from the title; fall back to filename.
- Canonical period key: `YYYYQn` (e.g., `2022Q2`), plus a `period_end_date` (quarter-end).

---

## 3. Functional requirements

### 3.1 Data ingestion / ETL
- **R1.** Ingest an arbitrary number of quarterly workbooks of both file types from a known input location (folder of `.xlsx`).
- **R2.** Parse each workbook into normalized long-format records (see §4 data model).
- **R3.** Idempotent re-ingest: re-running on the same files yields the same dataset (key on NAIC × period × policy_type × metric).
- **R4.** New-quarter onboarding: dropping a new quarter's files into the input folder and re-running ingestion adds that period with no code change. The dimension lists (companies, policy types) auto-extend.
- **R5.** Validation report on ingest: row counts, Total-row checksum vs. summed body rows (flag if mismatch beyond tolerance), count of suppressed (`.`) cells, list of unrecognized policy types, and companies new/dropped vs. prior quarter.
- **R6.** Persist the normalized dataset to a single queryable store (see §6). Raw files retained for re-derivation.

### 3.2 Core analytical capabilities (the "cut & splice" engine)
The app must let the user build a view by choosing, in any combination:

- **Metric** (one or more): policies in force, direct premium written, total exposure/TIV, new policies written, cancellations, nonrenewals, takeouts (received from other insurers), hurricane-risk cancellations/nonrenewals, plus the wind-included/wind-excluded variants where available.
- **Entity dimension:** company (NAIC), or "all companies."
- **Line dimension:** Commercial Residential / Personal Residential / both.
- **Policy-type dimension:** specific policy type(s) or rolled up.
- **Wind dimension:** all / wind-only / excl-wind / incl-wind (where the source supports it).
- **Time dimension:** single quarter (snapshot) or a range of quarters (time series).

From those selections the app must support:

- **R7.** **Snapshot ranking table** — e.g., all carriers ranked by TIV for 2022Q2, filterable to commercial only. Sortable by any metric.
- **R8.** **Market share** — each entity's share of a metric within the selected slice for a selected period (e.g., DPW market share). Show as % and absolute, with a Top-N + "all others" rollup option.
- **R9.** **Time series** — one or more entities' metric plotted across the selected quarter range (e.g., American Coastal TIV over time). Support multiple series on one chart for comparison.
- **R10.** **Aggregations** — sum/rollup across the chosen slice (e.g., total commercial TIV statewide per quarter; total personal DPW). The selected filters define the aggregation scope.
- **R11.** **Derived metrics** (computed, not in source): 
  - QoQ and YoY growth (%) for any metric/series.
  - Net policy flow = new written − cancelled − nonrenewed (+ received − transferred) per quarter.
  - Average premium per policy = DPW / PIF.
  - Implied rate-on-line proxy = DPW / TIV (premium as % of exposure).
  - Wind concentration = wind-incl TIV / total TIV.
  - Market-share delta vs. prior period.
- **R12.** **Multi-entity comparison** — pick 2–N carriers and compare any metric, snapshot or time series.

### 3.3 Presentation
- **R13.** Interactive **data table**: sort, filter, search by company name/NAIC, column show/hide, and CSV export of the current view.
- **R14.** Interactive **charts**: bar (ranking/market share), line/area (time series), stacked bar (commercial vs personal, or wind split). Hover tooltips with exact values; toggle absolute vs. % share.
- **R15.** Company name search must tolerate name drift — search hits should resolve to NAIC and pull the full history even if the display name changed across quarters.
- **R16.** Number formatting: dollars with thousands separators and unit labels (TIV often in $B/$T — offer $ / $K / $M / $B scaling); percentages to one decimal; show "—" or a "suppressed" marker for `.`/null cells, never 0.
- **R17.** Every view shows its active filter context (period(s), line, policy type, wind, metric) so the user always knows what slice they're looking at.

### 3.4 Nice-to-have (explicitly out of scope for v1, list for roadmap)
- Saved/bookmarkable views.
- Automated quarterly fetch from FLOIR (v1 assumes manual file drop).
- Entity grouping by parent/group (e.g., roll subsidiaries into a corporate group) — useful but requires a hand-maintained NAIC→group mapping; defer.
- Annotations / event overlays (e.g., hurricane dates, insolvencies like the FedNat/UPC failures visible in the data).

---

## 4. Data model (normalized)

Normalize both file types into a single **long/tidy fact table**, plus dimension tables.

### Fact table: `observations`
One row per (period × NAIC × line × policy_type × wind_basis × metric):

| field | type | notes |
|-------|------|-------|
| period | string | `YYYYQn` |
| period_end_date | date | quarter end |
| naic_code | string | entity key |
| company_name | string | as reported that quarter (display) |
| line | enum | Commercial Residential / Personal Residential / (n/a for File A "total") |
| policy_type | string | leaf; null for File-A-derived rows |
| wind_basis | enum | all / incl_wind / excl_wind / wind_only |
| metric | enum | pif, dpw, tiv, new_written, cancelled, cancelled_hurricane, nonrenewed, nonrenewed_hurricane, transferred_out, received_in |
| value | float | null if suppressed |
| is_suppressed | bool | true if source was `.` |
| source_file_type | enum | A or B |
| source_file | string | provenance |

> Rationale for long format: it makes the "pick any metric × any dimension × snapshot-or-timeseries" engine a simple filter+groupby instead of a wide-table reshaping nightmare, and it absorbs schema additions (new policy types, new metrics) without migrations.

### Dimension tables
- `companies`: naic_code (PK), canonical/display name, set of historical names, first_seen_period, last_seen_period.
- `policy_types`: policy_type (PK), derived line, is_wind_only, product family.
- `periods`: period (PK), period_end_date, data_pulled_at, source files present (A/B).

### Reconciliation between File A and File B
- File B (company × policy type) can be **rolled up to** File A's granularity (company × commercial/personal totals). The ETL should reconcile: summing File B over policy types per company per line should approximate File A's commercial/personal columns. **Flag discrepancies** — they indicate either suppression, coverage gaps between the two reports, or schema drift.
- Decide a **source-of-truth policy:** for TIV/exposure, wind split, and flow metrics → File B is the only source. For company-level commercial/personal DPW and PIF totals → either works; prefer File B rolled up for internal consistency, but keep File A available and cross-checked. Document the choice in code.

---

## 5. Non-functional requirements

- **Performance:** Dataset is small by DB standards — ~500 rows/quarter in File B × ~35 quarters ≈ <20k fact rows pre-normalization, low hundreds of thousands post-normalization. Everything should be instant. No pagination performance concerns; favor in-memory/SQLite-class simplicity.
- **Local-first:** This is a personal analyst tool. It should run locally with a single command. No auth, no multi-tenant, no cloud dependency required for v1.
- **Reproducibility:** ETL is deterministic and re-runnable; the normalized store can always be rebuilt from raw files.
- **Data integrity over cleverness:** never silently coerce `.` to 0, never drop the Total row without logging, never join on company name.
- **Extensibility:** adding a new quarter or a newly-introduced policy type must not require code changes (R4).

---

## 6. Suggested technical approach (non-binding — implementer's discretion)

This section is guidance, not a mandate. Choose what's fastest to build well.

- **ETL:** Python + pandas/openpyxl. A single ingestion module that (a) detects file type by sheet name / header signature, (b) locates the header row by scanning for anchor columns, (c) strips metadata rows and the Total footer, (d) melts to long format, (e) parses policy_type into line/wind, (f) cleans `.`→null and `$x,xxx`→float, (g) writes to the store and emits a validation report.
- **Store:** SQLite (or DuckDB — well-suited to this analytical, columnar slice-and-dice workload and trivial to embed). A single file the app queries.
- **Backend/API:** a thin query layer exposing parameterized slices (filters → aggregated/long results). FastAPI is a reasonable default; or skip a server and query the DB directly from the frontend build if going fully local.
- **Frontend:** React. Charts via Recharts or similar. A flexible filter panel (metric, line, policy type, wind basis, company multi-select, period range) driving a table + chart pane. CSV export of current view.
- **Repo layout suggestion:**
  - `/data/raw/` — dropped quarterly xlsx files
  - `/etl/` — ingestion + validation
  - `/data/florida_pc.db` — normalized store (gitignored, rebuildable)
  - `/api/` — query layer (if used)
  - `/web/` — React app
  - `/docs/` — this PRD, data dictionary, validation reports

---

## 7. Acceptance criteria (v1 done = all true)

1. Ingesting the provided 2022Q2 File A and File B produces a normalized dataset with the Total rows excluded and the published statewide totals reproduced (within rounding) as a checksum.
2. Dropping additional quarters' files and re-running ingestion extends the time axis with zero code changes; newly-appearing policy types are auto-discovered and surfaced.
3. User can produce: (a) a carrier ranking by TIV for a chosen quarter, filterable to commercial-only; (b) DPW market-share view; (c) a multi-quarter time series of a single carrier's TIV (American Coastal as the test case); (d) a two-carrier comparison.
4. Suppressed (`.`) values render as suppressed, never as 0, and are excluded from sums in a defensible, documented way.
5. Company-name search resolves across name drift via NAIC and returns full history.
6. Every metric in §3.2 R11 (growth, net flow, avg premium, DPW/TIV, wind concentration) is computable and correct on a spot-checked carrier.
7. Current view is CSV-exportable.

---

## 8. Open questions for Nithin (resolve before/early in build)

1. **Group rollups:** Do you want subsidiary→parent grouping in v1 (e.g., combining a group's NAICs), or is per-NAIC sufficient to start? (Affects whether a group-mapping table is needed.)
2. **File coverage:** Are all ~30 historical quarters available in *both* file types, or do some quarters only have one? (Affects whether TIV/wind/flow history is complete or has gaps.)
3. **Schema stability:** Have older quarters' column orderings or policy-type wordings differed from 2022Q2? If you know of any renames, list them so the parser can map them.
4. **Source-of-truth preference** for the overlapping company-level commercial/personal totals (File A as published vs. File B rolled up).
5. **Deployment:** purely local single-user, or do you want it hosted so you can reach it remotely (ties into your existing Tailscale setup)?
