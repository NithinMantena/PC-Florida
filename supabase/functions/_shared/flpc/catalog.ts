// get_catalog: one call that tells an LLM everything that's available
// (port of api/flpc/catalog.py).

import { DIMS, plabel } from "./engine.ts";
import { type Cell, Result } from "./fmt.ts";
import * as M from "./metrics.ts";
import type { Store } from "./store.ts";

const WORKFLOW = `Typical drill-down (each step ~1 call):
1. timeseries(metrics=['tiv'], line='commercial') -> spot the quarter with the jump.
2. compare_periods(metric='tiv', period_from='2026Q1', period_to='2026Q2', line='commercial') -> which carriers drove it (share_of_net_change_%).
3. compare_periods(metric='tiv', period_from='2026Q1', period_to='2026Q2', companies=['American Integrity'], line='commercial', group_by='policy_type') -> which policy types.
Other: rank (league table / market share), company_profile (one-shot carrier summary), market_overview (quarter headline + movers), find_companies (name -> NAIC), run_sql (anything else).`;

const CAVEATS = [
  "Source: Florida OIR QUASR / Quarterly-MIR residential market-share workbooks (company x policy type). Florida residential property only (personal + commercial residential), statewide.",
  "Stocks (pif, tiv, dpw, claims_pending, lawsuits_open_*) are as of quarter end; flows (new_written, cancelled, claims_opened, ...) are counts during the quarter.",
  "Suppressed cells ('.') are excluded from sums, never treated as 0. Ratios are ratio-of-sums.",
  "Companies are keyed by NAIC (names change over time). Citizens = NAIC 10064; use exclude_companies=['10064'] for the private market.",
  "Carrier groups come from an editable NAIC->group mapping applied to all quarters; unmapped companies are standalone groups.",
  "Period syntax: '2026Q1', 'latest', 'latest-1' (prior quarter), 'latest-4' (same quarter last year).",
  "Filters (all tools that aggregate): companies, groups, exclude_companies (names or NAICs), line ('commercial'|'personal'), policy_types (ids, product families or id prefixes like 'c_cmp'), wind_only (true|false).",
];

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function getCatalog(store: Store): Result {
  const r = new Result("Florida P&C residential market data — catalog");
  const first = store.periods[0], last = store.periods[store.periods.length - 1];
  const nReal = [...store.groups.values()].filter((g) => !g.standalone).length;
  r.context.push(`periods: ${first[0]}..${last[0]} (${store.periods.length} quarters, latest=${last[0]}); ` +
    `companies: ${store.companies.size} NAICs; carrier groups: ${nReal} multi-NAIC groups; ` +
    `policy types: ${store.policyTypes.size}; data built ${store.meta.generated_at ?? "?"}`);
  if (store.lastError) r.context.push(`WARNING: ${store.lastError} (serving previous data)`);
  const missing: string[] = [];
  for (let i = first[1]; i <= store.latestIdx; i++) if (!store.idxPeriod.has(i)) missing.push(plabel(i));
  if (missing.length) r.context.push(`gaps (no data): ${missing.join(", ")}`);

  const baseRows: Cell[][] = [];
  for (const m of M.BASE.values()) {
    const a = store.metricAvail.get(m.id);
    if (!a) continue;
    baseRows.push([m.id, m.unit, m.kind, a[0] !== first[1] ? plabel(a[0]) : "all", m.desc]);
  }
  r.add(["metric", "unit", "kind", "from", "description"], baseRows, "Base metrics");
  const derRows: Cell[][] = [];
  for (const m of M.DERIVED.values()) {
    if (!m.deps.every((d) => store.metricAvail.has(d))) continue;
    const start = Math.max(...m.deps.map((d) => store.metricAvail.get(d)![0]));
    derRows.push([m.id, m.unit, m.kind, start !== first[1] ? plabel(start) : "all", m.formula]);
  }
  r.add(["metric", "unit", "kind", "from", "formula"], derRows,
    "Derived metrics (ratio = not additive: no share/contribution)");

  r.add(["pt_id", "line", "product", "wind_only", "policy_type"],
    [...store.policyTypes.values()].map((p) => [p.id, p.line, p.product, p.wind_only ? "Y" : "", p.name]),
    "Policy types (filter with policy_types=[pt_id or product])");

  const fam = new Map<string, Set<string>>();
  for (const p of store.policyTypes.values()) {
    if (!fam.has(p.product)) fam.set(p.product, new Set());
    fam.get(p.product)!.add(p.line[0]);
  }
  r.notes.push("group_by dimensions (max 2): " + Object.keys(DIMS).join(", ") + ". Products: " +
    [...fam].sort((x, y) => cmpStr(x[0], y[0])).map(([k, v]) => `${k}(${[...v].sort(cmpStr).join("/")})`)
      .join(", ") + ".");
  r.notes.push("Multi-NAIC carrier groups: " + [...store.groups.values()].sort((x, y) => cmpStr(x.name, y.name))
    .filter((g) => !g.standalone).map((g) => `${g.name} (${g.members.length})`).join("; "));
  r.notes.push(...CAVEATS);
  r.notes.push(WORKFLOW);
  return r;
}
