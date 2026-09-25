#!/usr/bin/env python3
"""
Florida P&C Market Explorer — ETL / ingestion.

Scans the data folder for FLOIR QUASR / Quarterly-MIR residential market-share
workbooks (both file types), normalizes them into a single longitudinal dataset,
and writes a self-contained `web/data.js` that the static frontend loads (no
server needed) plus a human-readable validation report.

Design notes (see Florida_PC_PRD.md):
  * Columns are mapped by HEADER TEXT, never by position. Column counts drift
    across quarters (Type B: 19 -> 29 -> 34 cols; Type A: 9 -> 39 -> 57 cols);
    later quarters merely append claims / lawsuit metrics. Matching on header
    text makes the parser immune to that drift and to the date wording changing
    inside each header.
  * The reporting quarter is taken from the filename token (e.g. `2022q2`),
    which is stable; the title's date range wording is not (it changes from
    "4/1/2022-6/30/2022" to "January 1, 2026 - March 31, 2026").
  * NAIC code is the stable entity key and is kept as a string.
  * Suppressed cells (a literal ".") become null + is_suppressed, never 0.
  * The footer "Total" row is detected and excluded from entity rollups, but is
    retained as a published checksum for validation.
  * Re-running is idempotent and, when the same period appears twice, the file
    with the newest pull-timestamp in its name wins.

Outputs: web/data.js (static explorer), data/florida_pc.sqlite (local API /
MCP server store), validation_report.txt, and optionally (--push) the hosted
Supabase store behind the public API.

Run:  python etl/ingest.py            (see --help for input/output options)
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date

import openpyxl

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
ETL_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.dirname(ETL_DIR)                 # the "Florida P&C" folder
WEB_DIR = os.path.join(DATA_DIR, "web")
OUT_DATA_JS = os.path.join(WEB_DIR, "data.js")
OUT_REPORT = os.path.join(DATA_DIR, "validation_report.txt")
OUT_SQLITE = os.path.join(DATA_DIR, "data", "florida_pc.sqlite")
DEFAULT_GROUPS = os.path.join(DATA_DIR, "config", "carrier_groups.csv")

# --------------------------------------------------------------------------- #
# Header -> canonical metric mapping
#
# Each entry: (canonical_key, predicate(normalized_header) -> bool).
# Predicates are evaluated in order; the FIRST match wins, so more specific
# rules (e.g. "exclude wind", "due to hurricane") must precede general ones.
# `h` is the header lowercased with all whitespace collapsed to single spaces.
# --------------------------------------------------------------------------- #

def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s).replace("\n", " ")).strip().lower() if s is not None else ""


# ---- Type B (company x policy type) -------------------------------------- #
# Returns canonical metric key or None.
B_METRIC_RULES = [
    # --- policies in force (count). Anchor on "number of policies in force"
    #     at the START so we don't swallow the exposure/premium headers, which
    #     also contain the phrase "...for policies in force that exclude wind". ---
    ("pif_excl_wind", lambda h: h.startswith("number of policies in force") and "exclude wind" in h),
    ("pif_incl_wind", lambda h: h.startswith("number of policies in force") and "include wind" in h),
    ("pif", lambda h: h.startswith("total number of policies in force")),
    # --- policy flow (count) ---
    ("cancelled_hurricane", lambda h: "canceled due to hurricane" in h),
    ("cancelled", lambda h: "policies canceled" in h),
    ("nonrenewed_hurricane", lambda h: "nonrenewed due to hurricane" in h),
    ("nonrenewed", lambda h: "policies nonrenewed" in h),
    ("transferred_out", lambda h: "transferred to other insurers" in h),
    ("new_written", lambda h: "new policies written" in h),
    ("received_in", lambda h: "received from other insurers" in h),
    # --- exposure / TIV (dollars) ---
    ("tiv_excl_wind", lambda h: "value of exposure" in h and "exclude wind" in h),
    ("tiv_incl_wind", lambda h: "value of exposure" in h and "include wind" in h),
    ("tiv", lambda h: "value of exposure" in h),
    # --- direct premium written (dollars) ---
    ("dpw_excl_wind", lambda h: "direct premium written" in h and "exclude wind" in h),
    ("dpw_incl_wind", lambda h: "direct premium written" in h and "include wind" in h),
    ("dpw", lambda h: "direct premium written" in h),
    # --- claims (count; newer quarters only) ---
    ("claims_opened", lambda h: h.startswith("total number of claims opened")),
    ("claims_closed", lambda h: h.startswith("total number of claims closed")),
    ("claims_pending", lambda h: h.startswith("total number of claims pending")),
    # --- claims dispute resolution (count; newer quarters only). "another
    #     form of alternate" must precede the generic "alternative" rule. ---
    ("claims_adr_other", lambda h: "claims where another form of alternate dispute resolution" in h),
    ("claims_adr", lambda h: "claims where alternative dispute resolution" in h),
    ("claims_mediation", lambda h: "claims where mediation" in h),
    ("claims_arbitration", lambda h: "claims where arbitration" in h),
    ("claims_appraisal", lambda h: "claims where appraisal" in h),
    ("claims_sinkhole_eval", lambda h: "claims where neutral evaluation for sink holes" in h),
    ("claims_settlement_conf", lambda h: "claims where settlement conference" in h),
    # --- lawsuits (count; newest quarters only) ---
    ("lawsuits_closed_consumer", lambda h: "lawsuits closed with consideration" in h),
    ("lawsuits_closed", lambda h: h.startswith("number of lawsuits closed")),
    ("lawsuits_opened", lambda h: h.startswith("number of lawsuits opened")),
    ("lawsuits_open_begin", lambda h: "lawsuits open at beginning" in h),
    ("lawsuits_open_end", lambda h: "lawsuits open at end" in h),
]

# Anchor / dimension columns for Type B
B_DIM_RULES = [
    ("naic", lambda h: h == "naic code"),
    ("company", lambda h: h == "company name"),
    ("policy_type", lambda h: h == "policy type"),
]

# ---- Type A (company x commercial/personal) ------------------------------ #
A_METRIC_RULES = [
    ("a_pif_commercial", lambda h: "policies in force that are commercial" in h),
    ("a_pif_personal", lambda h: "policies in force that are personal" in h),
    ("a_pif", lambda h: h.startswith("total number of policies in force")),
    ("a_dpw_commercial", lambda h: "direct premium written for policies in force that are commercial" in h),
    ("a_dpw_personal", lambda h: "direct premium written for policies in force that are personal" in h),
    ("a_dpw", lambda h: h.startswith("total direct premium written for policies in force")),
]
A_DIM_RULES = [
    ("rank", lambda h: h.startswith("rank by total")),
    ("company", lambda h: h == "company name"),
    ("naic", lambda h: h == "naic code"),
]


def classify(header_norm: str, rules) -> str | None:
    for key, pred in rules:
        if pred(header_norm):
            return key
    return None


# --------------------------------------------------------------------------- #
# Value cleaning
# --------------------------------------------------------------------------- #

def clean_number(v):
    """Return (value_or_None, is_suppressed). Handles '.', '$1,234', floats."""
    if v is None:
        return None, False
    if isinstance(v, (int, float)):
        return float(v), False
    s = str(v).strip()
    if s == "" :
        return None, False
    if s == ".":
        return None, True            # suppressed / redacted, NOT zero
    s = re.sub(r"[\$,\s]", "", s)
    if s in ("", "-"):
        return None, False
    try:
        return float(s), False
    except ValueError:
        return None, False


# --------------------------------------------------------------------------- #
# Period / quarter helpers
# --------------------------------------------------------------------------- #
QUARTER_END = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


def parse_period_from_filename(fname: str):
    m = re.search(r"(\d{4})q([1-4])", fname.lower())
    if not m:
        return None
    yyyy, q = int(m.group(1)), int(m.group(2))
    mm, dd = QUARTER_END[q]
    return f"{yyyy}Q{q}", date(yyyy, mm, dd).isoformat()


def parse_timestamp_token(fname: str) -> str:
    """The trailing pull-timestamp token, e.g. 20221220t133802, for dedupe."""
    m = re.search(r"(\d{8}t\d{6})", fname.lower())
    return m.group(1) if m else ""


# --------------------------------------------------------------------------- #
# Workbook reading
# --------------------------------------------------------------------------- #

def load_sheet(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    sheet_name = wb.sheetnames[0]
    wb.close()
    return sheet_name, rows


def find_header_row(rows, anchor="company name", max_scan=10):
    """Locate the header row by scanning for the 'Company name' anchor."""
    for i, r in enumerate(rows[:max_scan]):
        if any(_norm(c) == anchor for c in r):
            return i
    return None


def title_and_pulled(rows):
    title = _norm(rows[0][0]) if rows and rows[0] else ""
    pulled = ""
    if len(rows) > 1 and rows[1] and rows[1][0]:
        m = re.search(r"data pulled on (.+?)\)", str(rows[1][0]), re.I)
        pulled = m.group(1).strip() if m else str(rows[1][0]).strip()
    return rows[0][0] if (rows and rows[0]) else "", pulled


def is_total_row(name_cell) -> bool:
    return _norm(name_cell) == "total"


# --------------------------------------------------------------------------- #
# Policy-type parsing (line + wind-only) — discovered, not hardcoded
# --------------------------------------------------------------------------- #

def parse_policy_type(pt: str):
    p = pt.strip()
    low = p.lower()
    if low.startswith("commercial residential"):
        line = "Commercial Residential"
    elif low.startswith("personal residential"):
        line = "Personal Residential"
    else:
        line = "Other"            # surfaced as a data-quality warning
    is_wind_only = "wind only" in low
    return line, is_wind_only, (line == "Other")


# Short, stable IDs for policy types (used by the API / MCP tools). Built by
# ordered phrase substitution so newly-introduced types still get a readable
# slug without code changes. Each rule: (phrase, token, product_family|None).
_PT_RULES = [
    ("homeowners (excl tenant and condo) - owner occupied", "ho", "ho"),
    ("condominium unit owners", "condo_unit", "condo_unit"),
    ("dwelling/fire - mobile homeowners", "mh_df", "mh_df"),
    ("mobile homeowners", "mh", "mh"),
    ("(homeowners association)", "hoa", None),
    ("(apartment buildings)", "apartments", None),
    ("(condo associations only)", "condo_assoc", None),
    ("(excl condo associations)", "excl_condo_assoc", None),
    ("dwelling/fire", "df", "df"),
    ("allied lines", "allied", "allied"),
    ("primary private flood", "flood_primary", "flood"),
    ("excess private flood", "flood_excess", "flood"),
    ("farmowners", "farm", "farm"),
    ("tenants", "tenants", "tenants"),
    ("cmp", "cmp", "cmp"),
    ("wind only dwellings", "wind", None),
    ("wind only", "wind", None),
]


def policy_type_id(pt: str):
    """Return (pt_id, product) e.g. ('c_cmp_condo_assoc', 'cmp')."""
    low = re.sub(r"\s+", " ", pt.strip().lower())
    prefix = "o"
    for pre, code in (("commercial residential", "c"), ("personal residential", "p")):
        if low.startswith(pre):
            prefix, low = code, low[len(pre):]
            break
    product = None
    for phrase, token, fam in _PT_RULES:
        if phrase in low:
            low = low.replace(phrase, f" {token} ")
            product = product or fam
    slug = re.sub(r"[^a-z0-9]+", "_", low).strip("_") or "unknown"
    if product is None:
        product = "wind" if "wind only" in pt.lower() else slug
    return f"{prefix}_{slug}", product


# --------------------------------------------------------------------------- #
# Parse one Type B workbook
# --------------------------------------------------------------------------- #

def parse_type_b(path, period, period_end, warnings):
    sheet, rows = load_sheet(path)
    hdr_i = find_header_row(rows)
    if hdr_i is None:
        warnings.append(f"[B] {os.path.basename(path)}: no header row found; skipped")
        return [], None, None
    header = rows[hdr_i]
    # map column index -> canonical key (dims + metrics)
    colmap = {}
    for ci, cell in enumerate(header):
        hn = _norm(cell)
        if not hn:
            continue
        key = classify(hn, B_DIM_RULES) or classify(hn, B_METRIC_RULES)
        if key:
            colmap[ci] = key
    metric_cols = {ci: k for ci, k in colmap.items()
                   if k not in ("naic", "company", "policy_type")}
    # locate dim columns
    inv = {k: ci for ci, k in colmap.items()}
    if not all(k in inv for k in ("naic", "company", "policy_type")):
        warnings.append(f"[B] {os.path.basename(path)}: missing dim columns; skipped")
        return [], None, None

    facts = []
    total_row = None
    for r in rows[hdr_i + 1:]:
        if r is None or all(c is None for c in r):
            continue
        name = r[inv["company"]]
        rec = {}
        for ci, mkey in metric_cols.items():
            val, sup = clean_number(r[ci] if ci < len(r) else None)
            rec[mkey] = val
            if sup:
                rec.setdefault("_suppressed", []).append(mkey)
        if is_total_row(name):
            total_row = rec
            continue
        naic = ("" if r[inv["naic"]] is None else str(r[inv["naic"]]).strip())
        pt = ("" if r[inv["policy_type"]] is None else str(r[inv["policy_type"]]).strip())
        if not naic and not pt:
            continue
        line, wind_only, unknown = parse_policy_type(pt)
        if unknown:
            warnings.append(f"[B] {period}: unrecognized policy-type prefix: {pt!r}")
        fact = {
            "p": period,
            "naic": naic,
            "company": ("" if name is None else str(name).strip()),
            "pt": pt,
            "line": line,
            "wind_only": wind_only,
        }
        fact.update({k: v for k, v in rec.items() if k != "_suppressed"})
        if "_suppressed" in rec:
            fact["_sup"] = rec["_suppressed"]
        facts.append(fact)
    return facts, total_row, sorted(set(metric_cols.values()))


# --------------------------------------------------------------------------- #
# Parse one Type A workbook
# --------------------------------------------------------------------------- #

def parse_type_a(path, period, period_end, warnings):
    sheet, rows = load_sheet(path)
    hdr_i = find_header_row(rows)
    if hdr_i is None:
        warnings.append(f"[A] {os.path.basename(path)}: no header row found; skipped")
        return [], None
    header = rows[hdr_i]
    colmap = {}
    for ci, cell in enumerate(header):
        hn = _norm(cell)
        if not hn:
            continue
        key = classify(hn, A_DIM_RULES) or classify(hn, A_METRIC_RULES)
        if key:
            colmap[ci] = key
    inv = {k: ci for ci, k in colmap.items()}
    if not all(k in inv for k in ("naic", "company")):
        warnings.append(f"[A] {os.path.basename(path)}: missing dim columns; skipped")
        return [], None
    metric_cols = {ci: k for ci, k in colmap.items()
                   if k not in ("naic", "company", "rank")}

    facts = []
    total_row = None
    for r in rows[hdr_i + 1:]:
        if r is None or all(c is None for c in r):
            continue
        name = r[inv["company"]]
        rec = {}
        for ci, mkey in metric_cols.items():
            val, _ = clean_number(r[ci] if ci < len(r) else None)
            rec[mkey] = val
        if is_total_row(name):
            total_row = rec
            continue
        naic = ("" if r[inv["naic"]] is None else str(r[inv["naic"]]).strip())
        if not naic:
            continue
        fact = {"p": period, "naic": naic,
                "company": ("" if name is None else str(name).strip())}
        fact.update(rec)
        facts.append(fact)
    return facts, total_row


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def discover_files(input_dirs=None):
    """Return {('B'|'A', period): path} keeping newest pull-timestamp per slot.

    Several input folders may be given (e.g. the repo's bundled history plus a
    mounted drop-folder); the same newest-timestamp-wins rule applies across
    all of them.
    """
    chosen = {}
    for d in (input_dirs or [DATA_DIR]):
        for path in glob.glob(os.path.join(d, "*.xlsx")):
            base = os.path.basename(path)
            low = base.lower()
            if "by_company_and_policy_type" in low:
                ftype = "B"
            elif "by_company_and_commercial_personal" in low:
                ftype = "A"
            else:
                continue
            per = parse_period_from_filename(base)
            if not per:
                continue
            period, _ = per
            key = (ftype, period)
            ts = parse_timestamp_token(base)
            if key not in chosen or ts > chosen[key][1]:
                chosen[key] = (path, ts)
    return {k: v[0] for k, v in chosen.items()}


def _period_sort_key(p):
    return (int(p[:4]), int(p[-1]))


def load_groups(path):
    """Read the hand-maintained NAIC -> parent-group mapping (CSV: naic,group).

    Blank lines and lines starting with '#' are ignored. Missing file = no
    groups (every company is its own standalone group).
    """
    groups = {}
    if not path or not os.path.exists(path):
        return groups
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [x.strip() for x in line.split(",", 1)]
            if len(parts) != 2 or parts[0].lower() == "naic":
                continue
            groups[parts[0]] = parts[1]
    return groups


def group_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def build(input_dirs=None, groups_path=None):
    """Parse every workbook and return the normalized dataset as a dict."""
    files = discover_files(input_dirs)
    if not files:
        raise SystemExit(f"No FLOIR workbooks found in {input_dirs or [DATA_DIR]}")

    warnings = []
    facts_b, facts_a = [], []
    periods = {}                         # period -> metadata
    checksums = []                       # validation rows
    totals = []                          # (file_type, period, metric, value)
    metrics_seen = set()

    for (ftype, period), path in sorted(files.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        period_key, period_end = parse_period_from_filename(os.path.basename(path))
        sheet, rows = load_sheet(path)
        title_raw, pulled = title_and_pulled(rows)
        pmeta = periods.setdefault(period_key, {
            "period": period_key, "period_end": period_end,
            "pulled_at": pulled, "has_A": False, "has_B": False,
            "title": title_raw,
        })
        pmeta["pulled_at"] = pmeta["pulled_at"] or pulled

        if ftype == "B":
            f, total, mets = parse_type_b(path, period_key, period_end, warnings)
            facts_b.extend(f)
            pmeta["has_B"] = True
            pmeta["file_B"] = os.path.basename(path)
            if mets:
                metrics_seen.update(mets)
            # checksum: sum body PIF vs Total-row PIF
            body_pif = sum(x.get("pif") or 0 for x in f)
            tot_pif = (total or {}).get("pif")
            checksums.append(("B", period_key, "pif", body_pif, tot_pif,
                              len(f), os.path.basename(path)))
            for k, v in (total or {}).items():
                if k != "_suppressed" and v is not None:
                    totals.append(("B", period_key, k, v))
        else:
            f, total = parse_type_a(path, period_key, period_end, warnings)
            facts_a.extend(f)
            pmeta["has_A"] = True
            pmeta["file_A"] = os.path.basename(path)
            body_pif = sum(x.get("a_pif") or 0 for x in f)
            tot_pif = (total or {}).get("a_pif")
            checksums.append(("A", period_key, "a_pif", body_pif, tot_pif,
                              len(f), os.path.basename(path)))
            for k, v in (total or {}).items():
                if v is not None:
                    totals.append(("A", period_key, k, v))

    # ---- build dimension tables ----------------------------------------- #
    companies = {}
    for fct in facts_b + facts_a:
        naic = fct["naic"]
        c = companies.setdefault(naic, {"naic": naic, "names": {}, "periods": set()})
        nm = fct.get("company", "")
        if nm:
            c["names"][nm] = c["names"].get(nm, 0) + 1
        c["periods"].add(fct["p"])

    period_order = sorted(periods.keys(), key=_period_sort_key)
    group_map = load_groups(groups_path)
    companies_out = {}
    for naic, c in companies.items():
        # most frequent name = display label
        display = max(c["names"].items(), key=lambda kv: kv[1])[0] if c["names"] else naic
        pers = sorted(c["periods"], key=_period_sort_key)
        companies_out[naic] = {
            "naic": naic,
            "name": display,
            "names": sorted(c["names"].keys()),
            "first": pers[0] if pers else None,
            "last": pers[-1] if pers else None,
            "group": group_map.get(naic),
        }
    for naic in group_map:
        if naic not in companies_out:
            warnings.append(f"[groups] NAIC {naic} ({group_map[naic]}) not found in any workbook")

    policy_types = {}
    for fct in facts_b:
        pt = fct["pt"]
        if pt and pt not in policy_types:
            line, wind_only, _ = parse_policy_type(pt)
            policy_types[pt] = {"policy_type": pt, "line": line, "is_wind_only": wind_only}
    # short IDs (deterministic; de-duplicated if two strings slug the same)
    used = set()
    for pt in sorted(policy_types):
        pid, product = policy_type_id(pt)
        base, n = pid, 2
        while pid in used:
            pid, n = f"{base}_{n}", n + 1
        used.add(pid)
        policy_types[pt].update({"id": pid, "product": product})

    # canonical metric order = rule order
    metric_order = [k for k, _ in B_METRIC_RULES if k in metrics_seen]

    return {
        "generated_at": _now(),
        "input_dirs": list(input_dirs or [DATA_DIR]),
        "files": files,
        "periods_meta": periods,
        "period_order": period_order,
        "periods": [periods[p] for p in period_order],
        "companies": companies_out,
        "policy_types": policy_types,
        "metrics_b": metric_order,
        "facts_b": facts_b,
        "facts_a": facts_a,
        "checksums": checksums,
        "totals": totals,
        "warnings": warnings,
    }


def write_data_js(data, path=OUT_DATA_JS):
    """The static web explorer's dataset (unchanged shape)."""
    web = {
        "generated_at": data["generated_at"],
        "periods": data["periods"],
        "companies": {n: {k: v for k, v in c.items() if k != "group"}
                      for n, c in data["companies"].items()},
        "policy_types": {pt: {k: d[k] for k in ("policy_type", "line", "is_wind_only")}
                         for pt, d in data["policy_types"].items()},
        "metrics_b": sorted(data["metrics_b"]),
        "facts_b": data["facts_b"],
        "facts_a": data["facts_a"],
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("// AUTO-GENERATED by etl/ingest.py — do not edit by hand.\n")
        fh.write("window.FL_DATA = ")
        json.dump(web, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")


LINE_CODE = {"Commercial Residential": "commercial", "Personal Residential": "personal"}


# Column types of the normalized store. `facts` gets one REAL column per
# metric captured, after these dimension columns.
STORE_SCHEMA = {
    "meta": [("key", "TEXT PRIMARY KEY"), ("value", "TEXT")],
    "periods": [("period", "TEXT PRIMARY KEY"), ("idx", "INTEGER"), ("year", "INTEGER"),
                ("quarter", "INTEGER"), ("period_end", "TEXT"), ("pulled_at", "TEXT"), ("source_file", "TEXT")],
    "companies": [("naic", "TEXT PRIMARY KEY"), ("name", "TEXT"), ("names", "TEXT"), ("group_id", "TEXT"),
                  ("group_name", "TEXT"), ("first_period", "TEXT"), ("last_period", "TEXT")],
    "groups": [("group_id", "TEXT PRIMARY KEY"), ("group_name", "TEXT"), ("standalone", "INTEGER"),
               ("members", "TEXT")],
    "policy_types": [("pt_id", "TEXT PRIMARY KEY"), ("policy_type", "TEXT"), ("line", "TEXT"),
                     ("product", "TEXT"), ("wind_only", "INTEGER")],
    "metrics": [("metric", "TEXT PRIMARY KEY"), ("first_period", "TEXT"), ("last_period", "TEXT"),
                ("n_periods", "INTEGER")],
    "facts": [("period", "TEXT"), ("idx", "INTEGER"), ("naic", "TEXT"), ("group_id", "TEXT"), ("pt_id", "TEXT"),
              ("line", "TEXT"), ("product", "TEXT"), ("wind_only", "INTEGER")],
    "suppressed": [("period", "TEXT"), ("naic", "TEXT"), ("pt_id", "TEXT"), ("metric", "TEXT")],
    "published_totals": [("file_type", "TEXT"), ("period", "TEXT"), ("metric", "TEXT"), ("value", "REAL")],
    "summary_a": [("period", "TEXT"), ("naic", "TEXT"), ("company", "TEXT"), ("a_pif", "REAL"),
                  ("a_pif_commercial", "REAL"), ("a_pif_personal", "REAL"), ("a_dpw", "REAL"),
                  ("a_dpw_commercial", "REAL"), ("a_dpw_personal", "REAL")],
}


def store_tables(data):
    """The normalized store as {table: (columns, rows)}.

    Shared by the local SQLite store (`write_sqlite`) and the hosted Supabase
    store (`write_bundle` / `push_bundle`), so both hold identical rows.
    """
    metrics = data["metrics_b"]
    order = data["period_order"]
    pidx = {p: _period_sort_key(p)[0] * 4 + _period_sort_key(p)[1] - 1 for p in order}
    comps = data["companies"]

    # groups: mapped companies share a group; everyone else is standalone
    groups = {}
    comp_group = {}
    for naic, c in comps.items():
        if c.get("group"):
            gid = group_slug(c["group"])
            groups.setdefault(gid, {"name": c["group"], "members": []})["members"].append(naic)
        else:
            gid = naic
            groups[gid] = {"name": c["name"], "members": [naic], "standalone": True}
        comp_group[naic] = gid

    t = {}
    t["meta"] = [
        ("generated_at", data["generated_at"]),
        ("latest_period", order[-1]),
        ("source_files", json.dumps(sorted(os.path.basename(p) for p in data["files"].values()))),
    ]
    t["periods"] = [
        (p, pidx[p], int(p[:4]), int(p[-1]), data["periods_meta"][p]["period_end"],
         data["periods_meta"][p]["pulled_at"], data["periods_meta"][p].get("file_B"))
        for p in order]
    t["companies"] = [
        (n, c["name"], " | ".join(c["names"]), comp_group[n], groups[comp_group[n]]["name"],
         c["first"], c["last"]) for n, c in comps.items()]
    t["groups"] = [
        (gid, g["name"], 1 if g.get("standalone") else 0, ",".join(sorted(g["members"])))
        for gid, g in groups.items()]
    pts = data["policy_types"]
    t["policy_types"] = [
        (d["id"], pt, LINE_CODE.get(d["line"], "other"), d["product"], int(d["is_wind_only"]))
        for pt, d in pts.items()]

    avail = defaultdict(set)
    facts, sup_rows = {}, []
    for f in data["facts_b"]:
        if not f["pt"]:
            continue
        d = pts[f["pt"]]
        vals = [f.get(m) for m in metrics]
        for m, v in zip(metrics, vals):
            if v is not None:
                avail[m].add(f["p"])
        # one row per (period, naic, policy type); a later duplicate replaces it
        facts[(f["p"], f["naic"], d["id"])] = (
            f["p"], pidx[f["p"]], f["naic"], comp_group[f["naic"]], d["id"],
            LINE_CODE.get(d["line"], "other"), d["product"], int(d["is_wind_only"]), *vals)
        for m in f.get("_sup", []):
            sup_rows.append((f["p"], f["naic"], d["id"], m))
    t["facts"] = list(facts.values())
    t["suppressed"] = sup_rows
    t["metrics"] = [
        (m, min(avail[m], key=_period_sort_key), max(avail[m], key=_period_sort_key), len(avail[m]))
        for m in metrics if avail[m]]
    t["published_totals"] = [tuple(x) for x in data["totals"]]
    a_cols = ["a_pif", "a_pif_commercial", "a_pif_personal", "a_dpw", "a_dpw_commercial", "a_dpw_personal"]
    t["summary_a"] = [(f["p"], f["naic"], f.get("company"), *[f.get(k) for k in a_cols]) for f in data["facts_a"]]

    out = {}
    for name, cols in STORE_SCHEMA.items():
        names = [c for c, _ in cols] + (list(metrics) if name == "facts" else [])
        out[name] = (names, t[name])
    return out


def write_sqlite(data, path=OUT_SQLITE):
    """Write the normalized store the API / MCP server queries.

    Written to a temp file and atomically swapped in, so a running server
    never sees a half-built database.
    """
    import sqlite3

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    tables = store_tables(data)
    cur = con.cursor()
    for name, cols in STORE_SCHEMA.items():
        defs = [f"{c} {typ}" for c, typ in cols]
        if name == "facts":
            defs += [f"{m} REAL" for m in data["metrics_b"]] + ["PRIMARY KEY(period, naic, pt_id)"]
        cur.execute(f"CREATE TABLE {name}({', '.join(defs)})")
        names, rows = tables[name]
        cur.executemany(f"INSERT INTO {name} VALUES ({','.join('?' * len(names))})", rows)
    cur.executescript("""
        CREATE INDEX ix_facts_idx ON facts(idx);
        CREATE INDEX ix_facts_naic ON facts(naic);
        CREATE INDEX ix_facts_group ON facts(group_id);
    """)
    con.commit()
    con.close()
    os.replace(tmp, path)


BUNDLE_FORMAT = 1


def bundle_bytes(data) -> bytes:
    """The store as gzipped JSON: the body of the hosted API's /admin/load."""
    import gzip

    tables = store_tables(data)
    doc = {"format": BUNDLE_FORMAT, "generated_at": data["generated_at"],
           "tables": {name: {"columns": cols, "rows": rows} for name, (cols, rows) in tables.items()}}
    return gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)


def write_bundle(data, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(bundle_bytes(data))


def push_bundle(data, url, token, timeout=120):
    """Replace the hosted (Supabase) store with this dataset in one transaction.

    `url` is the API base, e.g. https://<ref>.supabase.co/functions/v1/flpc, and
    `token` an API token with the `load` scope.
    """
    import urllib.error
    import urllib.request

    body = bundle_bytes(data)
    req = urllib.request.Request(url.rstrip("/") + "/admin/load", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Content-Encoding": "gzip",
        "User-Agent": "flpc-etl"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:2000]
        raise SystemExit(f"push failed: HTTP {e.code} {detail}") from None


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description="Rebuild the Florida P&C dataset from FLOIR workbooks.")
    ap.add_argument("--input", action="append", dest="inputs",
                    help="folder of .xlsx workbooks (repeatable; default: repo root)")
    ap.add_argument("--groups", default=DEFAULT_GROUPS, help="carrier group CSV (naic,group)")
    ap.add_argument("--sqlite", default=OUT_SQLITE, help="SQLite output path")
    ap.add_argument("--no-web", action="store_true", help="skip writing web/data.js")
    ap.add_argument("--no-report", action="store_true", help="skip validation_report.txt")
    ap.add_argument("--bundle", help="also write the gzipped JSON load bundle to this path")
    ap.add_argument("--push", action="store_true",
                    help="upload the dataset to the hosted API (env FLPC_URL + FLPC_LOAD_TOKEN)")
    ap.add_argument("--url", default=os.environ.get("FLPC_URL"), help="hosted API base URL for --push")
    ap.add_argument("--token", default=os.environ.get("FLPC_LOAD_TOKEN"), help="API token with the load scope")
    args = ap.parse_args(argv)
    if args.push and not (args.url and args.token):
        ap.error("--push needs --url/FLPC_URL and --token/FLPC_LOAD_TOKEN")

    data = build(args.inputs, args.groups)
    outputs = []
    if not args.no_web:
        write_data_js(data)
        outputs.append(OUT_DATA_JS)
    if args.sqlite:
        write_sqlite(data, args.sqlite)
        outputs.append(args.sqlite)
    if not args.no_report:
        write_report(data)
        outputs.append(OUT_REPORT)
    if args.bundle:
        write_bundle(data, args.bundle)
        outputs.append(args.bundle)

    print(f"OK  periods={len(data['period_order'])}  facts_B={len(data['facts_b'])}  "
          f"facts_A={len(data['facts_a'])}  companies={len(data['companies'])}  "
          f"policy_types={len(data['policy_types'])}")
    for o in outputs:
        print(f"    wrote {o}")
    if data["warnings"]:
        print(f"    {len(data['warnings'])} warning(s) — see report")
    if args.push:
        res = push_bundle(data, args.url, args.token)
        print(f"    pushed to {args.url}: {res.get('periods')} periods, latest {res.get('latest_period')}, "
              f"{res.get('rows', {}).get('facts')} fact rows (load {res.get('load_id')})")


def _now():
    from datetime import datetime
    return datetime.now().isoformat(timespec="seconds")


def write_report(data, path=OUT_REPORT):
    files, periods, period_order = data["files"], data["periods_meta"], data["period_order"]
    checksums, warnings = data["checksums"], data["warnings"]
    facts_b, facts_a = data["facts_b"], data["facts_a"]
    companies, policy_types = data["companies"], data["policy_types"]
    metrics_seen = data["metrics_b"]
    L = []
    L.append("FLORIDA P&C — INGEST VALIDATION REPORT")
    L.append(f"generated: {_now()}")
    L.append(f"input dir(s): {', '.join(data['input_dirs'])}")
    L.append("")
    L.append(f"files ingested: {len(files)}")
    L.append(f"periods: {len(period_order)}  ({period_order[0]} .. {period_order[-1]})")
    L.append(f"Type-B facts (company x policy type): {len(facts_b)}")
    L.append(f"Type-A facts (company x comm/personal): {len(facts_a)}")
    L.append(f"distinct companies (NAIC): {len(companies)}")
    L.append(f"distinct policy types: {len(policy_types)}")
    L.append(f"metrics captured (Type B): {', '.join(sorted(metrics_seen))}")
    L.append("")
    L.append("PERIOD COVERAGE (A=comm/personal, B=policy type):")
    for p in period_order:
        m = periods[p]
        L.append(f"  {p}  A={'Y' if m['has_A'] else '-'}  B={'Y' if m['has_B'] else '-'}"
                 f"  pulled={m['pulled_at']}")
    L.append("")
    L.append("TOTAL-ROW CHECKSUM (body sum vs published Total row, PIF):")
    L.append(f"  {'type':4} {'period':7} {'metric':6} {'body_sum':>14} {'total_row':>14} {'diff':>10} {'rows':>5}")
    for ftype, period, metric, body, tot, n, fn in sorted(checksums, key=lambda x: (x[1], x[0])):
        diff = "" if tot is None else f"{body - tot:,.0f}"
        tots = "" if tot is None else f"{tot:,.0f}"
        flag = ""
        if tot is not None and tot != 0 and abs(body - tot) / tot > 0.0001:
            flag = "  <-- MISMATCH"
        L.append(f"  {ftype:4} {period:7} {metric:6} {body:>14,.0f} {tots:>14} {diff:>10} {n:>5}{flag}")
    L.append("")
    if warnings:
        L.append(f"WARNINGS ({len(warnings)}):")
        for w in warnings:
            L.append(f"  - {w}")
    else:
        L.append("WARNINGS: none")
    L.append("")
    L.append("POLICY TYPES DISCOVERED:")
    for pt in sorted(policy_types):
        d = policy_types[pt]
        L.append(f"  [{d['line'][:4]}{' WIND' if d['is_wind_only'] else '    '}] {d['id']:<24} {pt}")
    L.append("")
    grouped = defaultdict(list)
    for c in companies.values():
        if c.get("group"):
            grouped[c["group"]].append(c["name"])
    L.append(f"CARRIER GROUPS ({len(grouped)} multi-NAIC groups; others standalone):")
    for g in sorted(grouped):
        L.append(f"  {g}: {'; '.join(sorted(grouped[g]))}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
