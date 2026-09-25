// Metric registry (port of api/flpc/metrics.py): base metrics (columns in
// `facts`) and derived metrics computed from summed base columns.
//
// Units: count | usd (scaled to $K/$M/$B for display) | usd_each (per-policy $)
//        | pct (fraction, shown as %) | rate (per 1,000).
// Kind:  stock (as of quarter end) | flow (during the quarter) | ratio
//        (derived, non-additive: cannot be summed, shared or attributed).

import { UserError } from "./fmt.ts";

export type Sums = Record<string, number | null>;

export interface Metric {
  id: string;
  label: string;
  unit: string;
  kind: string;
  desc: string;
  deps: string[];
  fn: ((v: Sums) => number | null) | null;
  formula: string;
  additive: boolean;
  derived: boolean;
}

const B: [string, string, string, string, string][] = [
  ["pif", "Policies in force", "count", "stock", "Total policies in force at quarter end"],
  ["pif_incl_wind", "PIF incl. wind", "count", "stock", "Policies in force that include wind coverage"],
  ["pif_excl_wind", "PIF excl. wind", "count", "stock", "Policies in force that exclude wind coverage"],
  ["tiv", "TIV / exposure", "usd", "stock", "Total dollar value of exposure (TIV) of policies in force at quarter end"],
  ["tiv_incl_wind", "TIV incl. wind", "usd", "stock", "Exposure of policies that include wind coverage"],
  ["tiv_excl_wind", "TIV excl. wind", "usd", "stock", "Exposure of policies that exclude wind coverage"],
  ["dpw", "Direct premium written", "usd", "stock", "Direct premium written for the policies in force at quarter end (in-force written premium; a stock, not quarterly sales)"],
  ["dpw_incl_wind", "DPW incl. wind", "usd", "stock", "Direct premium written for policies that include wind"],
  ["dpw_excl_wind", "DPW excl. wind", "usd", "stock", "Direct premium written for policies that exclude wind"],
  ["new_written", "New policies written", "count", "flow", "New policies written during the quarter"],
  ["received_in", "Policies received (takeouts)", "count", "flow", "Policies received from other insurers (takeouts/assumptions, incl. from Citizens)"],
  ["transferred_out", "Policies transferred out", "count", "flow", "Policies transferred to other insurers"],
  ["cancelled", "Policies cancelled", "count", "flow", "Policies cancelled during the quarter"],
  ["cancelled_hurricane", "Cancelled (hurricane risk)", "count", "flow", "Policies cancelled due to hurricane risk"],
  ["nonrenewed", "Policies nonrenewed", "count", "flow", "Policies nonrenewed during the quarter"],
  ["nonrenewed_hurricane", "Nonrenewed (hurricane risk)", "count", "flow", "Policies nonrenewed due to hurricane risk"],
  ["claims_opened", "Claims opened", "count", "flow", "Claims opened during the quarter"],
  ["claims_closed", "Claims closed", "count", "flow", "Claims closed during the quarter"],
  ["claims_pending", "Claims pending", "count", "stock", "Claims pending at quarter end"],
  ["claims_adr", "Claims w/ ADR", "count", "flow", "Claims where alternative dispute resolution was invoked"],
  ["claims_mediation", "Claims w/ mediation", "count", "flow", "Claims where mediation was invoked"],
  ["claims_arbitration", "Claims w/ arbitration", "count", "flow", "Claims where arbitration was invoked"],
  ["claims_appraisal", "Claims w/ appraisal", "count", "flow", "Claims where appraisal was invoked"],
  ["claims_sinkhole_eval", "Claims w/ sinkhole eval", "count", "flow", "Claims where neutral evaluation for sinkholes was invoked"],
  ["claims_settlement_conf", "Claims w/ settlement conf.", "count", "flow", "Claims where a settlement conference was invoked"],
  ["claims_adr_other", "Claims w/ other ADR", "count", "flow", "Claims where another form of ADR was invoked"],
  ["lawsuits_opened", "Lawsuits opened", "count", "flow", "Lawsuits opened during the quarter"],
  ["lawsuits_closed", "Lawsuits closed", "count", "flow", "Lawsuits closed during the quarter"],
  ["lawsuits_closed_consumer", "Lawsuits closed for consumer", "count", "flow", "Lawsuits closed with consideration for the consumer"],
  ["lawsuits_open_begin", "Lawsuits open (begin)", "count", "stock", "Lawsuits open at beginning of quarter"],
  ["lawsuits_open_end", "Lawsuits open (end)", "count", "stock", "Lawsuits open at end of quarter"],
];

function div(a: number | null | undefined, b: number | null | undefined, k = 1): number | null {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return (a / b) * k;
}

function sum(xs: (number | null | undefined)[], signs?: number[]): number | null {
  if (xs.some((x) => x === null || x === undefined)) return null;
  let t = 0;
  xs.forEach((x, i) => (t += (signs ? signs[i] : 1) * (x as number)));
  return t;
}

const D: [string, string, string, string, string[], (v: Sums) => number | null, string][] = [
  ["net_flow", "Net policy flow", "count", "flow",
    ["new_written", "received_in", "cancelled", "nonrenewed", "transferred_out"],
    (v) => sum([v.new_written, v.received_in, v.cancelled, v.nonrenewed, v.transferred_out], [1, 1, -1, -1, -1]),
    "new_written + received_in - cancelled - nonrenewed - transferred_out"],
  ["lapses", "Cancelled + nonrenewed", "count", "flow", ["cancelled", "nonrenewed"],
    (v) => sum([v.cancelled, v.nonrenewed]), "cancelled + nonrenewed"],
  ["avg_premium", "Avg premium per policy", "usd_each", "ratio", ["dpw", "pif"],
    (v) => div(v.dpw, v.pif), "dpw / pif"],
  ["avg_tiv", "Avg TIV per policy", "usd_each", "ratio", ["tiv", "pif"],
    (v) => div(v.tiv, v.pif), "tiv / pif"],
  ["premium_per_1k_tiv", "Premium per $1k TIV (rate-on-line)", "usd_each", "ratio", ["dpw", "tiv"],
    (v) => div(v.dpw, v.tiv, 1000), "dpw / tiv * 1000"],
  ["wind_share_tiv", "Share of TIV with wind", "pct", "ratio", ["tiv_incl_wind", "tiv"],
    (v) => div(v.tiv_incl_wind, v.tiv), "tiv_incl_wind / tiv"],
  ["wind_share_pif", "Share of PIF with wind", "pct", "ratio", ["pif_incl_wind", "pif"],
    (v) => div(v.pif_incl_wind, v.pif), "pif_incl_wind / pif"],
  ["new_business_rate", "New policies / PIF", "pct", "ratio", ["new_written", "pif"],
    (v) => div(v.new_written, v.pif), "new_written / pif (quarterly)"],
  ["cancel_rate", "Cancellations / PIF", "pct", "ratio", ["cancelled", "pif"],
    (v) => div(v.cancelled, v.pif), "cancelled / pif (quarterly)"],
  ["nonrenew_rate", "Nonrenewals / PIF", "pct", "ratio", ["nonrenewed", "pif"],
    (v) => div(v.nonrenewed, v.pif), "nonrenewed / pif (quarterly)"],
  ["claims_per_1k_pif", "Claims opened per 1k PIF", "rate", "ratio", ["claims_opened", "pif"],
    (v) => div(v.claims_opened, v.pif, 1000), "claims_opened / pif * 1000 (quarterly)"],
  ["adr_rate", "ADR claims / claims opened", "pct", "ratio", ["claims_adr", "claims_opened"],
    (v) => div(v.claims_adr, v.claims_opened), "claims_adr / claims_opened"],
  ["lawsuits_per_1k_claims", "Lawsuits opened per 1k claims", "rate", "ratio", ["lawsuits_opened", "claims_opened"],
    (v) => div(v.lawsuits_opened, v.claims_opened, 1000), "lawsuits_opened / claims_opened * 1000"],
];

export const BASE = new Map<string, Metric>(
  B.map(([id, label, unit, kind, desc]) => [id, {
    id, label, unit, kind, desc, deps: [], fn: null, formula: "", additive: kind !== "ratio", derived: false,
  }]),
);

export const DERIVED = new Map<string, Metric>(
  D.map(([id, label, unit, kind, deps, fn, formula]) => [id, {
    id, label, unit, kind, desc: formula, deps, fn, formula, additive: kind !== "ratio", derived: true,
  }]),
);

export const ALL = new Map<string, Metric>([...BASE, ...DERIVED]);

export const base = (id: string): Metric => BASE.get(id)!;
export const derived = (id: string): Metric => DERIVED.get(id)!;

const ALIASES: Record<string, string> = {
  exposure: "tiv", tiv_total: "tiv", total_insured_value: "tiv", insured_value: "tiv",
  premium: "dpw", premiums: "dpw", dwp: "dpw", direct_premium_written: "dpw", written_premium: "dpw",
  policies: "pif", policies_in_force: "pif", policy_count: "pif", pifs: "pif",
  new_business: "new_written", new_policies: "new_written",
  takeouts: "received_in", received: "received_in", transfers_out: "transferred_out",
  cancellations: "cancelled", canceled: "cancelled", nonrenewals: "nonrenewed", non_renewed: "nonrenewed",
  claims: "claims_opened", lawsuits: "lawsuits_opened",
  rate_on_line: "premium_per_1k_tiv", rol: "premium_per_1k_tiv",
  average_premium: "avg_premium", avg_premium_per_policy: "avg_premium",
  net_policy_flow: "net_flow", wind_concentration: "wind_share_tiv",
};

export function get(mid: unknown): Metric {
  let key = String(mid).trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
  key = ALIASES[key] ?? key;
  const m = ALL.get(key);
  if (!m) throw new UserError(`Unknown metric '${mid}'. Valid: ${[...ALL.keys()].join(", ")} (see get_catalog).`);
  return m;
}

/** Base columns needed to compute the given metrics (ordered, unique). */
export function baseDeps(metrics: Metric[]): string[] {
  const out: string[] = [];
  for (const m of metrics) {
    for (const d of m.derived ? m.deps : [m.id]) if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Metric value from a dict of summed base columns. */
export function compute(m: Metric, sums: Sums | null | undefined): number | null {
  if (m.derived) return m.fn!(sums ?? {});
  return sums?.[m.id] ?? null;
}
