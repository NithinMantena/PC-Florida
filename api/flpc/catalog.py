"""get_catalog: one call that tells an LLM everything that's available."""

from __future__ import annotations

from collections import defaultdict

from . import metrics as M
from .engine import DIMS, plabel
from .fmt import Response
from .store import Store

WORKFLOW = """Typical drill-down (each step ~1 call):
1. timeseries(metrics=['tiv'], line='commercial') -> spot the quarter with the jump.
2. compare_periods(metric='tiv', period_from='2026Q1', period_to='2026Q2', line='commercial') -> which carriers drove it (share_of_net_change_%).
3. compare_periods(metric='tiv', period_from='2026Q1', period_to='2026Q2', companies=['American Integrity'], line='commercial', group_by='policy_type') -> which policy types.
Other: rank (league table / market share), company_profile (one-shot carrier summary), market_overview (quarter headline + movers), find_companies (name -> NAIC), run_sql (anything else)."""

CAVEATS = [
    "Source: Florida OIR QUASR / Quarterly-MIR residential market-share workbooks (company x policy type). Florida residential property only (personal + commercial residential), statewide.",
    "Stocks (pif, tiv, dpw, claims_pending, lawsuits_open_*) are as of quarter end; flows (new_written, cancelled, claims_opened, ...) are counts during the quarter.",
    "Suppressed cells ('.') are excluded from sums, never treated as 0. Ratios are ratio-of-sums.",
    "Companies are keyed by NAIC (names change over time). Citizens = NAIC 10064; use exclude_companies=['10064'] for the private market.",
    "Carrier groups come from an editable NAIC->group mapping applied to all quarters; unmapped companies are standalone groups.",
    "Period syntax: '2026Q1', 'latest', 'latest-1' (prior quarter), 'latest-4' (same quarter last year).",
    "Filters (all tools that aggregate): companies, groups, exclude_companies (names or NAICs), line ('commercial'|'personal'), policy_types (ids, product families or id prefixes like 'c_cmp'), wind_only (true|false).",
]


def get_catalog(store: Store) -> Response:
    r = Response("Florida P&C residential market data — catalog")
    p0, p1 = store.periods[0][0], store.periods[-1][0]
    n_real = sum(1 for g in store.groups.values() if not g["standalone"])
    r.context.append(f"periods: {p0}..{p1} ({len(store.periods)} quarters, latest={p1}); "
                     f"companies: {len(store.companies)} NAICs; carrier groups: {n_real} multi-NAIC groups; "
                     f"policy types: {len(store.policy_types)}; data built {store.meta.get('generated_at', '?')}")
    if store.last_error:
        r.context.append(f"WARNING: {store.last_error} (serving previous data)")
    missing = [plabel(i) for i in range(store.periods[0][1], store.latest_idx + 1) if i not in store.idx_period]
    if missing:
        r.context.append(f"gaps (no data): {', '.join(missing)}")

    rows = []
    for m in M.BASE.values():
        a = store.metric_avail.get(m.id)
        if not a:
            continue
        rows.append([m.id, m.unit, m.kind, plabel(a[0]) if a[0] != store.periods[0][1] else "all", m.desc])
    r.add(["metric", "unit", "kind", "from", "description"], rows, title="Base metrics")
    rows = []
    for m in M.DERIVED.values():
        if not all(d in store.metric_avail for d in m.deps):
            continue
        start = max(store.metric_avail[d][0] for d in m.deps)
        rows.append([m.id, m.unit, m.kind, plabel(start) if start != store.periods[0][1] else "all", m.formula])
    r.add(["metric", "unit", "kind", "from", "formula"], rows,
          title="Derived metrics (ratio = not additive: no share/contribution)")

    r.add(["pt_id", "line", "product", "wind_only", "policy_type"],
          [[p.id, p.line, p.product, "Y" if p.wind_only else "", p.name] for p in store.policy_types.values()],
          title="Policy types (filter with policy_types=[pt_id or product])")

    fam = defaultdict(set)
    for p in store.policy_types.values():
        fam[p.product].add(p.line[0])
    r.notes.append("group_by dimensions (max 2): " + ", ".join(DIMS) + ". Products: " +
                   ", ".join(f"{k}({'/'.join(sorted(v))})" for k, v in sorted(fam.items())) + ".")
    r.notes.append("Multi-NAIC carrier groups: " + "; ".join(
        f"{g['name']} ({len(g['members'])})" for g in sorted(store.groups.values(), key=lambda g: g["name"])
        if not g["standalone"]))
    r.notes.extend(CAVEATS)
    r.notes.append(WORKFLOW)
    return r
