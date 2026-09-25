// Query engine and tool implementations (port of api/flpc/engine.py).
//
// All aggregation happens in Postgres (SUM over the tidy flpc.facts table
// grouped by the requested dimensions and quarter); derived metrics are
// computed from the summed base columns, so ratios are always ratio-of-sums,
// never averages of ratios. Suppressed source cells (a literal "." in the
// workbook) are NULL and excluded from sums; responses note when a slice
// contains any. Output matches the Python engine value for value.

import { getCloseMatches } from "./difflib.ts";
import { type Cell, num, pct, pyRound, Result, Scale, UserError } from "./fmt.ts";
import * as M from "./metrics.ts";
import type { Metric, Sums } from "./metrics.ts";
import type { Db, Store } from "./store.ts";

export const MAX_METRICS = 8;
export const MAX_TOP_N = 100;

type Args = Record<string, unknown>;

// --------------------------------------------------------------------------
// Input helpers
// --------------------------------------------------------------------------

/** Accept a list or a delimited string; return a clean list or null. */
export function asList(x: unknown, split: RegExp | null = /,/): string[] | null {
  if (x === null || x === undefined) return null;
  let items: string[];
  if (Array.isArray(x)) items = x.filter((i) => i !== null && i !== undefined).map((i) => String(i));
  else items = split ? String(x).split(split) : [String(x)];
  items = items.map((i) => i.trim()).filter((i) => i);
  return items.length ? items : null;
}

export function plabel(idx: number): string {
  return `${Math.floor(idx / 4)}Q${(idx % 4) + 1}`;
}

export function toInt(v: unknown, dflt: number): number {
  if (v === null || v === undefined || v === "" || v === 0 || v === false) return dflt;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new UserError(`Expected an integer, got '${v}'.`);
  return Math.trunc(n);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** 'latest', 'latest-4', '2026Q1', '2026-Q1', 'Q1 2026' -> period index. */
export function parsePeriod(store: Store, s: unknown, dflt: string | null = null): number | null {
  if (s === null || s === undefined || String(s).trim() === "") {
    if (dflt === null) return null;
    s = dflt;
  }
  const t = String(s).trim().toLowerCase().replaceAll(" ", "");
  let idx: number;
  const m = /^(?:latest|last|current)(?:-(\d+))?$/.exec(t);
  if (m) idx = store.latestIdx - Number(m[1] ?? 0);
  else {
    const m1 = /^(\d{4})[-_/]?q([1-4])$/.exec(t);
    const m2 = /^q([1-4])[-_/]?(\d{4})$/.exec(t);
    if (m1) idx = Number(m1[1]) * 4 + Number(m1[2]) - 1;
    else if (m2) idx = Number(m2[2]) * 4 + Number(m2[1]) - 1;
    else throw new UserError(`Bad period '${s}'. Use e.g. '2026Q1', 'latest' or 'latest-4'.`);
  }
  if (!store.idxPeriod.has(idx)) {
    const p0 = store.periods[0][0], p1 = store.periods[store.periods.length - 1][0];
    throw new UserError(`Period ${plabel(idx)} is not in the data. Available: ${p0}..${p1} (latest = ${p1}).`);
  }
  return idx;
}

// --------------------------------------------------------------------------
// Entity resolution
// --------------------------------------------------------------------------

const STOP = new Set(["insurance", "ins", "company", "co", "inc", "the", "of", "corp", "corporation",
  "incorporated", "llc", "and", "&", "group", "holdings"]);

const norm = (s: unknown) => String(s).toUpperCase().replace(/[^A-Z0-9& ]+/g, " ").trim();

function tokens(q: string): string[] {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  const kept = toks.filter((t) => !STOP.has(t.toLowerCase()));
  return kept.length ? kept : toks;
}

const isDigits = (s: string) => /^\d+$/.test(s);

/** naic -> TIV in the latest quarter (for ordering candidate lists). */
async function latestSize(store: Store): Promise<Map<string, number>> {
  if (store.sizeCache && store.sizeCache[0] === store.version) return store.sizeCache[1];
  const rows = await store.db.values(
    "SELECT naic, SUM(tiv)::float8 FROM flpc.facts WHERE idx = $1 GROUP BY naic", [store.latestIdx]);
  const sizes = new Map(rows.map((r) => [r[0] as string, (r[1] as number | null) || 0]));
  store.sizeCache = [store.version, sizes];
  return sizes;
}

export async function matchCompanies(store: Store, q: unknown): Promise<string[]> {
  const s = String(q).trim();
  if (!s) return [];
  if (store.companies.has(s)) return [s];
  if (isDigits(s)) return [];
  const nq = norm(s);
  const exact = [...store.companies].filter(([, c]) => c.names.some((x) => norm(x) === nq)).map(([n]) => n);
  if (exact.length) return exact;
  const toks = tokens(s);
  const out: string[] = [];
  for (const [n, c] of store.companies) {
    const hay = c.names.map(norm).join(" | ");
    if (toks.every((t) => hay.includes(t))) out.push(n);
  }
  const sizes = await latestSize(store);
  return out.sort((a, b) => -(sizes.get(a) ?? 0) - -(sizes.get(b) ?? 0));
}

function describeCandidates(store: Store, naics: string[], k = 8): string {
  return naics.slice(0, k).map((n) => {
    const c = store.companies.get(n)!;
    return `${c.name} (NAIC ${n}, last ${c.last})`;
  }).join("; ");
}

export async function resolveCompany(store: Store, q: unknown): Promise<string> {
  const hits = await matchCompanies(store, q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const gids = new Set(hits.map((n) => store.companies.get(n)!.group_id));
    let hint = "";
    const g0 = [...gids][0];
    if (gids.size === 1 && !store.groups.get(g0)!.standalone) {
      hint = ` They are all in group '${store.groups.get(g0)!.name}' — use groups=[...] to combine.`;
    }
    throw new UserError(`'${q}' matches ${hits.length} companies: ${describeCandidates(store, hits)}. ` +
      `Pass a NAIC code or a more specific name.${hint}`);
  }
  const names = new Map<string, string>();
  for (const [n, c] of store.companies) for (const x of c.names) names.set(x, n);
  const close = new Set(getCloseMatches(norm(q), [...names.keys()].map(norm), 5, 0.5));
  const sugg = [...names.keys()].filter((x) => close.has(norm(x)));
  throw new UserError(`No company matches '${q}'.` +
    (sugg.length ? ` Did you mean: ${sugg.join("; ")}?` : " Use find_companies to search."));
}

export async function resolveGroup(store: Store, q: unknown): Promise<string> {
  const s = String(q).trim();
  if (store.groups.has(s)) return s;
  const nq = norm(s);
  const real = [...store.groups].filter(([, d]) => !d.standalone);
  const exact = [...store.groups].filter(([, d]) => norm(d.name) === nq).map(([g]) => g);
  if (exact.length === 1) return exact[0];
  const toks = tokens(s);
  const hits = real.filter(([, d]) => toks.every((t) => norm(d.name).includes(t))).map(([g]) => g);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new UserError(`'${s}' matches several groups: ${hits.map((g) => store.groups.get(g)!.name).join(", ")}.`);
  }
  // a company name/NAIC resolves to that company's group
  const comp = await matchCompanies(store, s);
  if (comp.length === 1 || (comp.length && new Set(comp.map((n) => store.companies.get(n)!.group_id)).size === 1)) {
    return store.companies.get(comp[0])!.group_id;
  }
  throw new UserError(`No carrier group matches '${s}'. Multi-company groups: ` +
    `${real.map(([, d]) => d.name).sort(cmpStr).join(", ")}. Any single company also works as its own group.`);
}

const LINE_ALIASES: Record<string, string> = {
  commercial: "commercial", "commercial residential": "commercial", c: "commercial", comm: "commercial",
  personal: "personal", "personal residential": "personal", p: "personal", pers: "personal",
};

export function resolveLine(line: unknown): string | null {
  if (line === null || line === undefined) return null;
  const t = String(line).trim().toLowerCase().replaceAll("_", " ");
  if (["", "all", "both", "any", "total"].includes(t)) return null;
  if (!(t in LINE_ALIASES)) throw new UserError(`Bad line '${line}'. Use 'commercial', 'personal' or omit for both.`);
  return LINE_ALIASES[t];
}

export function resolvePolicyTypes(store: Store, items: unknown): string[] | null {
  const list = asList(items);
  if (!list) return null;
  const pts = [...store.policyTypes.values()];
  const out: string[] = [];
  for (const it of list) {
    const t = it.trim().toLowerCase();
    let hits = pts.filter((p) => [p.id, p.product, p.name.toLowerCase()].includes(t)).map((p) => p.id);
    if (!hits.length) hits = pts.filter((p) => p.id.startsWith(t)).map((p) => p.id);
    if (!hits.length && ["wind", "wind_only", "wind only"].includes(t)) {
      hits = pts.filter((p) => p.wind_only).map((p) => p.id);
    }
    if (!hits.length) {
      throw new UserError(`Unknown policy type '${it}'. Use an id (${[...store.policyTypes.keys()].join(", ")}) ` +
        `or a product family (${[...new Set(pts.map((p) => p.product))].sort(cmpStr).join(", ")}).`);
    }
    for (const h of hits) if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function resolveBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const t = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "only"].includes(t)) return true;
  if (["false", "no", "n", "0", "exclude", "none"].includes(t)) return false;
  if (["all", "any", "both"].includes(t)) return null;
  throw new UserError(`Bad boolean '${v}'.`);
}

// --------------------------------------------------------------------------
// Filters
// --------------------------------------------------------------------------

/** Positional query parameters ($1, $2, ...). */
class Params {
  list: unknown[] = [];
  add(v: unknown): string {
    this.list.push(v);
    return `$${this.list.length}`;
  }
  many(vs: unknown[]): string {
    return vs.map((v) => this.add(v)).join(",");
  }
}

export class Filters {
  naics: string[] | null = null;
  groupIds: string[] | null = null;
  exclude: string[] | null = null;
  line: string | null = null;
  ptIds: string[] | null = null;
  windOnly: boolean | null = null;
  labels: string[] = [];

  constructor(init: Partial<Filters> = {}) {
    Object.assign(this, init);
  }

  sql(p: Params, a = "f"): string[] {
    const where: string[] = [];
    if (this.naics?.length) where.push(`${a}.naic IN (${p.many(this.naics)})`);
    if (this.groupIds?.length) where.push(`${a}.group_id IN (${p.many(this.groupIds)})`);
    if (this.exclude?.length) where.push(`${a}.naic NOT IN (${p.many(this.exclude)})`);
    if (this.line) where.push(`${a}.line = ${p.add(this.line)}`);
    if (this.ptIds?.length) where.push(`${a}.pt_id IN (${p.many(this.ptIds)})`);
    if (this.windOnly !== null) where.push(`${a}.wind_only = ${p.add(this.windOnly ? 1 : 0)}`);
    return where;
  }

  describe(): string {
    return this.labels.length ? this.labels.join("; ") : "all companies, all lines & policy types";
  }
}

/** Company lists: a whole string that resolves wins; else split on , ; |. */
async function companiesArg(store: Store, x: unknown): Promise<string[] | null> {
  if (x === null || x === undefined) return null;
  if (typeof x === "string") {
    if ((await matchCompanies(store, x)).length === 1) return [x];
    return asList(x, /[;|,]/);
  }
  return asList(x, null);
}

export async function makeFilters(store: Store, a: Args): Promise<Filters> {
  const f = new Filters();
  const comps = await companiesArg(store, a.companies);
  if (comps) {
    f.naics = [];
    for (const c of comps) {
      const n = await resolveCompany(store, c);
      if (!f.naics.includes(n)) f.naics.push(n);
    }
    f.labels.push("companies=" + f.naics.map((n) => `${store.companies.get(n)!.name} (${n})`).join("; "));
  }
  const grps = typeof a.groups === "string" ? asList(a.groups, /[;|]/) : asList(a.groups, null);
  if (grps) {
    f.groupIds = [];
    for (const g of grps) {
      const gid = await resolveGroup(store, g);
      if (!f.groupIds.includes(gid)) f.groupIds.push(gid);
    }
    f.labels.push("groups=" + f.groupIds.map((g) => store.groups.get(g)!.name).join("; "));
  }
  const exc = await companiesArg(store, a.exclude_companies);
  if (exc) {
    f.exclude = [];
    for (const c of exc) f.exclude.push(await resolveCompany(store, c));
    f.labels.push("excluding " + f.exclude.map((n) => store.companies.get(n)!.name).join("; "));
  }
  f.line = resolveLine(a.line);
  if (f.line) f.labels.push(`line=${f.line}`);
  f.ptIds = resolvePolicyTypes(store, a.policy_types);
  if (f.ptIds) f.labels.push("policy_types=" + f.ptIds.join(","));
  f.windOnly = resolveBool(a.wind_only);
  if (f.windOnly !== null) {
    f.labels.push(f.windOnly ? "wind-only policy types" : "excluding wind-only policy types");
  }
  return f;
}

// --------------------------------------------------------------------------
// Dimensions + aggregation
// --------------------------------------------------------------------------

export const DIMS: Record<string, string> = {
  company: "f.naic", group: "f.group_id", line: "f.line", policy_type: "f.pt_id", product: "f.product",
  wind_only: "f.wind_only",
};
const DIM_ALIASES: Record<string, string> = {
  carrier: "company", companies: "company", naic: "company", insurer: "company", groups: "group",
  parent: "group", carrier_group: "group", lines: "line", policy_types: "policy_type", policy: "policy_type",
  pt: "policy_type", type: "policy_type", products: "product", product_family: "product", wind: "wind_only",
};

export function parseDims(groupBy: unknown, dflt: string | null = null): string[] {
  const items = groupBy !== null && groupBy !== undefined ? asList(groupBy) : asList(dflt);
  const out: string[] = [];
  for (const it of items ?? []) {
    let t = it.trim().toLowerCase().replaceAll(" ", "_");
    if (["none", "total", "all", ""].includes(t)) continue;
    t = DIM_ALIASES[t] ?? t;
    if (!(t in DIMS)) throw new UserError(`Bad group_by '${it}'. Use: ${Object.keys(DIMS).join(", ")} (max 2) or omit.`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 2) throw new UserError("group_by accepts at most 2 dimensions.");
  return out;
}

export function dimColumns(dims: string[]): string[] {
  const cols: string[] = [];
  for (const d of dims) cols.push(...(d === "company" ? ["naic", "company"] : [d]));
  return cols;
}

export function dimValues(store: Store, dims: string[], key: unknown[]): Cell[] {
  const vals: Cell[] = [];
  dims.forEach((d, i) => {
    const v = key[i];
    if (d === "company") {
      const c = store.companies.get(v as string);
      vals.push(v as string, c ? c.name : (v as string));
    } else if (d === "group") vals.push(store.groups.get(v as string)?.name ?? (v as string));
    else if (d === "wind_only") vals.push(v ? "wind-only" : "standard");
    else vals.push(v as Cell);
  });
  return vals;
}

/** One aggregated slice: its dimension key and per-period sums. */
export interface Group {
  key: unknown[];
  per: Map<number, Sums>;
}

const orderCol = (c: string) => (c === "f.wind_only" ? c : `${c} COLLATE "C"`);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedNums = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

/** Ordered {dim key: {idx: {col: sum}}}. Unreported metric-periods -> null. */
export async function aggregate(store: Store, colsIn: string[], dims: string[], flt: Filters,
  idxsIn: number[]): Promise<Map<string, Group>> {
  const cols = [...colsIn];
  const present = cols.filter((c) => store.metricCols.includes(c));
  const dcols = dims.map((d) => DIMS[d]);
  const p = new Params();
  const where = flt.sql(p);
  const idxs = sortedNums(idxsIn);
  where.push(`f.idx IN (${p.many(idxs)})`);
  const sel = [...dcols, "f.idx", ...present.map((c) => `SUM(f.${c})::float8`)];
  // ORDER BY keeps tie order deterministic (and identical to the local engine)
  const sql = `SELECT ${sel.join(", ")} FROM flpc.facts f WHERE ${where.join(" AND ")} ` +
    `GROUP BY ${[...dcols, "f.idx"].join(", ")} ORDER BY ${[...dcols.map(orderCol), "f.idx"].join(", ")}`;
  const out = new Map<string, Group>();
  const nd = dims.length;
  for (const r of await store.db.values(sql, p.list)) {
    const key = r.slice(0, nd);
    const idx = r[nd] as number;
    const vals: Sums = Object.fromEntries(cols.map((c) => [c, null]));
    present.forEach((c, j) => (vals[c] = store.available(c, idx) ? (r[nd + 1 + j] as number | null) : null));
    const k = JSON.stringify(key);
    let g = out.get(k);
    if (!g) out.set(k, (g = { key, per: new Map() }));
    g.per.set(idx, vals);
  }
  return out;
}

export function combine(sumsList: (Sums | undefined | null)[], cols: string[]): Sums {
  const out: Sums = Object.fromEntries(cols.map((c) => [c, null]));
  for (const s of sumsList) {
    if (!s) continue;
    for (const c of cols) {
      const v = s[c];
      if (v !== null && v !== undefined) out[c] = (out[c] || 0) + v;
    }
  }
  return out;
}

async function suppressedNote(store: Store, flt: Filters, colsIn: string[], idxsIn: number[]): Promise<string | null> {
  const p = new Params();
  const where = flt.sql(p, "f");
  where.push(`f.idx IN (${p.many(sortedNums(idxsIn))})`);
  const cols = colsIn.filter((c) => store.metricCols.includes(c));
  if (!cols.length) return null;
  where.push(`s.metric IN (${p.many(cols)})`);
  const r = await store.db.values(
    "SELECT COUNT(*)::int FROM flpc.suppressed s JOIN flpc.facts f USING (period, naic, pt_id) WHERE " +
      where.join(" AND "), p.list);
  const n = r[0][0] as number;
  if (n) {
    return `${n} source cell(s) in this slice were suppressed by FLOIR ('.') and are excluded ` +
      "from sums (not treated as 0).";
  }
  return null;
}

function checkAvailable(store: Store, ms: Metric[], idxs: number[]) {
  for (const m of ms) {
    for (const c of M.baseDeps([m])) {
      const a = store.metricAvail.get(c);
      if (!a) throw new UserError(`Metric '${m.id}' has no data in this dataset.`);
      const bad = idxs.filter((i) => !(a[0] <= i && i <= a[1]));
      if (bad.length && bad.length === idxs.length) {
        throw new UserError(`Metric '${m.id}' is only reported ${plabel(a[0])}..${plabel(a[1])}; ` +
          `requested ${idxs.map(plabel).join(", ")}.`);
      }
    }
  }
}

/** % change; undefined (null) when the base is <= 0 or the sign flips. */
function growth(v: number | null | undefined, prev: number | null | undefined): number | null {
  if (v === null || v === undefined || prev === null || prev === undefined || prev <= 0 || v < 0) return null;
  return v / prev - 1;
}

const scInt = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : pyRound(v, 0) || 0;

const truthy = (v: number | null | undefined) => v !== null && v !== undefined && v !== 0;

/** A number inside prose: null -> "n/a" (same as the local engine). */
const pf = (v: number | null) => (v === null ? "n/a" : String(v));

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

const TRANSFORMS = ["value", "qoq", "yoy", "diff", "share"];
const TRANSFORM_ALIASES: Record<string, string> = {
  pct_change: "qoq", growth: "qoq", change: "diff", abs: "value", market_share: "share", values: "value",
};

export async function timeseries(store: Store, a: Args): Promise<Result> {
  const ms = (asList(a.metrics) ?? []).map(M.get);
  if (!ms.length) throw new UserError("metrics is required, e.g. ['tiv'].");
  if (ms.length > MAX_METRICS) throw new UserError(`At most ${MAX_METRICS} metrics per call.`);
  const dims = parseDims(a.group_by);
  const flt = await makeFilters(store, a);
  let i0 = parsePeriod(store, a.start, store.periods[0][0])!;
  let i1 = parsePeriod(store, a.end, "latest")!;
  if (i0 > i1) [i0, i1] = [i1, i0];
  let transform = String(a.transform || "value").toLowerCase();
  transform = TRANSFORM_ALIASES[transform] ?? transform;
  if (!TRANSFORMS.includes(transform)) {
    throw new UserError(`Bad transform '${transform}'. Use one of ${TRANSFORMS.join(", ")}.`);
  }
  if (transform === "share" && ms.some((m) => !m.additive)) {
    throw new UserError("transform='share' only works for additive metrics (not ratios).");
  }
  const topN = clamp(toInt(a.top_n, 10), 1, MAX_TOP_N);
  const includeOther = a.include_other === undefined || a.include_other === null ? true : !!a.include_other;
  const raw = !!a.raw;
  const look = ({ yoy: 4, qoq: 1, diff: 1 } as Record<string, number>)[transform] ?? 0;
  const allIdx = store.periods.map(([, i]) => i).filter((i) => i0 - look <= i && i <= i1);
  const outIdx = allIdx.filter((i) => i >= i0);
  checkAvailable(store, ms, outIdx);

  const rankM = ms.find((m) => m.additive) ?? M.base("tiv");
  const cols = M.baseDeps([...ms, rankM]);
  const data = await aggregate(store, cols, dims, flt, allIdx);
  if (!data.size) throw new UserError(`No data for this slice (${flt.describe()}).`);
  const groups = [...data.values()];
  const total = new Map(allIdx.map((i) => [i, combine(groups.map((g) => g.per.get(i)), cols)]));

  let series: [Cell[], Map<number, Sums>][];
  if (dims.length) {
    const rankVal = (g: Group) => {
      for (const i of [...outIdx].reverse()) {
        const v = M.compute(rankM, g.per.get(i) ?? {});
        if (v !== null) return Math.abs(v);
      }
      return 0;
    };
    const keys = [...groups].sort((x, y) => rankVal(y) - rankVal(x));
    const top = keys.slice(0, topN), rest = keys.slice(topN);
    series = top.map((g) => [dimValues(store, dims, g.key), g.per]);
    const blank: Cell[] = Array(dimColumns(dims).length - 1).fill("");
    if (rest.length && includeOther) {
      const other = new Map(allIdx.map((i) => [i, combine(rest.map((g) => g.per.get(i)), cols)]));
      series.push([[...blank, `All others (${rest.length})`], other]);
    }
    if (keys.length > 1) series.push([[...blank, "Total"], total]);
  } else series = [[[], total]];

  const rowsRaw: [Cell[], Metric, (number | null)[]][] = [];
  for (const [labels, sums] of series) {
    for (const m of ms) {
      const vals: (number | null)[] = [];
      for (const i of outIdx) {
        let v = sums.get(i) ? M.compute(m, sums.get(i)) : null;
        if (transform === "diff") {
          const p = sums.get(i - 1) ? M.compute(m, sums.get(i - 1)) : null;
          v = v === null || p === null ? null : v - p;
        } else if (transform === "qoq" || transform === "yoy") {
          const p = sums.get(i - look) ? M.compute(m, sums.get(i - look)) : null;
          v = growth(v, p);
        } else if (transform === "share") {
          const t = M.compute(m, total.get(i));
          v = v === null || !t ? null : v / t;
        }
        vals.push(v);
      }
      rowsRaw.push([labels, m, vals]);
    }
  }

  const pctOut = ["qoq", "yoy", "share"].includes(transform);
  const scales = new Map<string, Scale>();
  for (const m of ms) {
    const allv = rowsRaw.filter(([, mm]) => mm === m).flatMap(([, , vals]) => vals);
    scales.set(m.id, pctOut ? new Scale("pct", [], raw) : new Scale(m.unit, allv, raw));
  }
  const mlabel = (m: Metric) => `${m.id} (${scales.get(m.id)!.label})`;
  const showMetric = ms.length > 1 || !dims.length;
  const colsOut = [...dimColumns(dims), ...(showMetric ? ["metric"] : []), ...outIdx.map(plabel)];
  const rows = rowsRaw.map(([labels, m, vals]) => {
    const sc = scales.get(m.id)!;
    const cells = pctOut ? vals.map((v) => pct(v)) : vals.map((v) => sc.fmt(v));
    return [...labels, ...(showMetric ? [mlabel(m)] : []), ...cells];
  });

  const tname = ({ value: "", qoq: " — QoQ % change", yoy: " — YoY % change", diff: " — QoQ change",
    share: " — % share of slice" } as Record<string, string>)[transform];
  const title = ms.map((m) => m.label).join(", ") + tname + (dims.length ? ` by ${dims.join(" × ")}` : "");
  const r = new Result(title);
  r.context.push(`filters: ${flt.describe()}`);
  r.context.push(`periods: ${plabel(outIdx[0])}..${plabel(outIdx[outIdx.length - 1])}` +
    (ms.length === 1 ? `; units: ${ms.map(mlabel).join(", ")}` : ""));
  if (dims.length && data.size > topN) {
    r.context.push(`showing top ${topN} of ${data.size} by ${rankM.id} at ${plabel(outIdx[outIdx.length - 1])}`);
  }
  r.add(colsOut, rows);
  const note = await suppressedNote(store, flt, cols, outIdx);
  if (note) r.notes.push(note);
  return r;
}

export async function rank(store: Store, a: Args): Promise<Result> {
  const m0 = M.get(a.metric ?? "");
  const extras = (asList(a.extra_metrics) ?? []).map(M.get).slice(0, MAX_METRICS - 1);
  const ms = [m0, ...extras];
  let dims = parseDims(a.group_by, "company");
  if (!dims.length) dims = ["company"];
  const flt = await makeFilters(store, a);
  const i = parsePeriod(store, a.period, "latest")!;
  const ic = parsePeriod(store, a.compare_to);
  const idxs = [i, ...(ic !== null ? [ic] : [])];
  checkAvailable(store, [m0], [i]);
  const topN = clamp(toInt(a.top_n, 20), 1, MAX_TOP_N);
  const ascending = resolveBool(a.ascending) ?? false;
  const raw = !!a.raw;
  const minPif = a.min_pif === null || a.min_pif === undefined ? (m0.additive ? 0 : 100) : Number(a.min_pif);
  const cols = M.baseDeps([...ms, M.base("pif")]);
  const data = await aggregate(store, cols, dims, flt, idxs);
  if (!data.size) throw new UserError(`No data for this slice (${flt.describe()}).`);
  const groups = [...data.values()];

  const totI = combine(groups.map((g) => g.per.get(i)), cols);
  const totC = ic !== null ? combine(groups.map((g) => g.per.get(ic)), cols) : null;
  const T0 = M.compute(m0, totI);
  const Tc = totC ? M.compute(m0, totC) : null;
  const entries: [unknown[], number, Sums, Sums | undefined][] = [];
  for (const g of groups) {
    const s = g.per.get(i);
    if (!s) continue;
    const v = M.compute(m0, s);
    if (v === null || (m0.kind === "stock" && v === 0)) continue;
    if ((s.pif || 0) < minPif) continue;
    entries.push([g.key, v, s, ic !== null ? g.per.get(ic) : undefined]);
  }
  entries.sort((x, y) => (ascending ? x[1] - y[1] : y[1] - x[1]));
  const shown = entries.slice(0, topN);

  const sc0 = new Scale(m0.unit, [...shown.map((e) => e[1]), T0], raw);
  const scx = new Map(extras.map((m) => [m.id, new Scale(m.unit, shown.map((e) => M.compute(m, e[2])), raw)]));
  const colsOut = ["rank", ...dimColumns(dims), `${m0.id} (${sc0.label})`];
  if (m0.additive) colsOut.push("share_%");
  colsOut.push(...extras.map((m) => `${m.id} (${scx.get(m.id)!.label})`));
  if (ic !== null) {
    colsOut.push(`${m0.id}@${plabel(ic)}`, "change", "change_%", ...(m0.additive ? ["share_chg_pp"] : []));
  }
  const rows: Cell[][] = [];
  shown.forEach(([k, v, s, sc_], n) => {
    const row: Cell[] = [n + 1, ...dimValues(store, dims, k), sc0.fmt(v)];
    if (m0.additive) row.push(T0 ? pct(v / T0) : null);
    row.push(...extras.map((m) => scx.get(m.id)!.fmt(M.compute(m, s))));
    if (ic !== null) {
      const pv = sc_ ? M.compute(m0, sc_) : (m0.additive ? 0 : null);
      row.push(sc0.fmt(pv), sc0.fmt(pv === null ? null : v - pv), pct(growth(v, pv)));
      if (m0.additive) row.push(T0 ? pyRound((v / T0 - (Tc ? (pv || 0) / Tc : 0)) * 100, 2) : null);
    }
    rows.push(row);
  });
  const blank: Cell[] = Array(dimColumns(dims).length - 1).fill("");
  const trow: Cell[] = ["", ...blank, `Total (${entries.length} ranked)`, sc0.fmt(T0)];
  if (m0.additive) trow.push(100.0);
  trow.push(...extras.map((m) => scx.get(m.id)!.fmt(M.compute(m, totI))));
  if (ic !== null) {
    trow.push(sc0.fmt(Tc), sc0.fmt(Tc === null || T0 === null ? null : T0 - Tc), pct(growth(T0, Tc)));
    if (m0.additive) trow.push("");
  }
  rows.push(trow);

  const r = new Result(`${m0.label} ranking by ${dims.join(" × ")} — ${plabel(i)}`);
  r.context.push(`filters: ${flt.describe()}`);
  if (!m0.additive) {
    r.context.push(`ratio metric: entities with < ${minPif} PIF excluded; total row = ratio of totals`);
  }
  r.add(colsOut, rows);
  const note = await suppressedNote(store, flt, cols, idxs);
  if (note) r.notes.push(note);
  return r;
}

export async function comparePeriods(store: Store, a: Args): Promise<Result> {
  const m = M.get(a.metric ?? "");
  let dims = parseDims(a.group_by, "company");
  if (!dims.length) dims = ["company"];
  const flt = await makeFilters(store, a);
  const ia = parsePeriod(store, a.period_from, "latest-1")!;
  const ib = parsePeriod(store, a.period_to, "latest")!;
  checkAvailable(store, [m], [ia]);
  checkAvailable(store, [m], [ib]);
  const topN = clamp(toInt(a.top_n, 15), 1, MAX_TOP_N);
  const raw = !!a.raw;
  const minPif = a.min_pif === null || a.min_pif === undefined ? (m.additive ? 0 : 500) : Number(a.min_pif);
  const cols = M.baseDeps([m, M.base("pif")]);
  const data = await aggregate(store, cols, dims, flt, [ia, ib]);
  if (!data.size) throw new UserError(`No data for this slice (${flt.describe()}).`);
  const groups = [...data.values()];

  const rowsRaw: [unknown[], number, number, number, string][] = [];
  for (const g of groups) {
    const sa = g.per.get(ia), sb = g.per.get(ib);
    let av = sa ? M.compute(m, sa) : null;
    let bv = sb ? M.compute(m, sb) : null;
    let status = "";
    if (m.additive) {
      status = !truthy(av) && truthy(bv) ? "new" : (truthy(av) && !truthy(bv) ? "exited" : "");
      av = av || 0;
      bv = bv || 0;
      if (av === 0 && bv === 0) continue;
    } else {
      if (av === null || bv === null) continue;
      if (Math.min(sa?.pif || 0, sb?.pif || 0) < minPif) continue;
    }
    rowsRaw.push([g.key, av, bv, bv - av, status]);
  }
  rowsRaw.sort((x, y) => Math.abs(y[3]) - Math.abs(x[3]));

  const A = M.compute(m, combine(groups.map((g) => g.per.get(ia)), cols));
  const Bv = M.compute(m, combine(groups.map((g) => g.per.get(ib)), cols));
  const net = A === null || Bv === null ? null : Bv - A;
  const shown = rowsRaw.slice(0, topN), rest = rowsRaw.slice(topN);
  const sc = new Scale(m.unit, [...shown.flatMap((x) => [x[1], x[2], x[3]]), A, Bv], raw);
  const la = plabel(ia), lb = plabel(ib);
  const colsOut = [...dimColumns(dims), `${la} (${sc.label})`, `${lb} (${sc.label})`, "change", "change_%"];
  if (m.additive) colsOut.push("share_of_net_change_%");
  const rows: Cell[][] = [];
  for (const [k, av, bv, d, status] of shown) {
    const labels = dimValues(store, dims, k);
    if (status) labels[labels.length - 1] = `${labels[labels.length - 1]} [${status}]`;
    const row: Cell[] = [...labels, sc.fmt(av), sc.fmt(bv), sc.fmt(d), pct(growth(bv, av))];
    if (m.additive) row.push(net ? pct(d / net) : null);
    rows.push(row);
  }
  const blank: Cell[] = Array(dimColumns(dims).length - 1).fill("");
  if (rest.length && m.additive) {
    let ra = 0, rb = 0;
    for (const x of rest) {
      ra += x[1];
      rb += x[2];
    }
    rows.push([...blank, `All others (${rest.length})`, sc.fmt(ra), sc.fmt(rb), sc.fmt(rb - ra),
      pct(growth(rb, ra)), net ? pct((rb - ra) / net) : null]);
  }
  rows.push([...blank, "Total", sc.fmt(A), sc.fmt(Bv), sc.fmt(net), pct(growth(Bv, A)),
    ...(m.additive ? [net ? 100.0 : null] : [])]);

  const r = new Result(`${m.label}: ${la} → ${lb} change by ${dims.join(" × ")}`);
  r.context.push(`filters: ${flt.describe()}`);
  r.context.push("sorted by absolute change" + (m.additive ? "" :
    `; ratio metric — entities with < ${minPif} PIF excluded; total = ratio of totals`));
  r.add(colsOut, rows);
  if (m.additive && net !== null) {
    const up = rowsRaw.filter((x) => x[3] > 0);
    const dn = rowsRaw.filter((x) => x[3] < 0);
    let gu = 0, gd = 0, topUp = 0;
    for (const x of up) gu += x[3];
    for (const x of dn) gd += x[3];
    for (const x of up.slice(0, 3)) topUp += x[3];
    r.notes.push(
      `Net change ${pf(sc.fmt(net))} ${sc.label} (${pf(pct(growth(Bv, A)))}%) = gross increases ${pf(sc.fmt(gu))} ` +
        `across ${up.length} + gross decreases ${pf(sc.fmt(gd))} across ${dn.length}.` +
        (gu ? ` Top 3 increases = ${pf(pct(topUp / gu))}% of gross increases.` : ""),
    );
  }
  const note = await suppressedNote(store, flt, cols, [ia, ib]);
  if (note) r.notes.push(note);
  return r;
}

const PROFILE_METRICS = ["pif", "tiv", "dpw", "new_written", "received_in", "cancelled", "nonrenewed", "net_flow",
  "claims_opened", "avg_premium", "avg_tiv", "premium_per_1k_tiv", "wind_share_tiv"];

async function resolveEntity(store: Store, company: unknown, group: unknown):
  Promise<[Filters, string, string, string, boolean]> {
  if (group) {
    const gid = await resolveGroup(store, group);
    return [new Filters({ groupIds: [gid] }), "group", gid, store.groups.get(gid)!.name, true];
  }
  if (!company) throw new UserError("Pass company (name or NAIC) or group.");
  let n: string;
  try {
    n = await resolveCompany(store, company);
  } catch (e) {
    let gid: string;
    try {
      gid = await resolveGroup(store, company);
    } catch {
      throw e;
    }
    return [new Filters({ groupIds: [gid] }), "group", gid, store.groups.get(gid)!.name, true];
  }
  return [new Filters({ naics: [n] }), "company", n, store.companies.get(n)!.name, false];
}

export async function companyProfile(store: Store, a: Args): Promise<Result> {
  const [flt, dim, key, label, isGroup] = await resolveEntity(store, a.company, a.group);
  const i = parsePeriod(store, a.period, "latest")!;
  const raw = !!a.raw;
  const ms = PROFILE_METRICS.map(M.get);
  const cols = M.baseDeps(ms);
  const trendIdx = store.periods.map(([, ix]) => ix).filter((ix) => i - 7 <= ix && ix <= i);
  const idxs = sortedNums([...trendIdx, ...[i - 1, i - 4].filter((ix) => store.idxPeriod.has(ix))]);
  const mine = (await aggregate(store, cols, [], flt, idxs)).get("[]")?.per ?? new Map<number, Sums>();
  if (!mine.get(i)) throw new UserError(`${label} has no data in ${plabel(i)}.`);
  const state = [...(await aggregate(store, cols, [dim], new Filters(), [i])).values()];

  const r = new Result(`Profile: ${label} — ${plabel(i)}`);
  if (isGroup) {
    const g = store.groups.get(key)!;
    r.context.push(`group of ${g.members.length} NAIC(s)` + (g.standalone ? " (standalone)" : ""));
  } else {
    const c = store.companies.get(key)!;
    r.context.push(`NAIC ${c.naic}; group: ${c.group_id !== c.naic ? c.group_name : "standalone"}; ` +
      `reported ${c.first}..${c.last}` + (c.names.length > 1 ? `; names used: ${c.names.join(" / ")}` : ""));
  }

  const rows: Cell[][] = [];
  for (const m of ms) {
    const v = M.compute(m, mine.get(i));
    if (v === null) continue;
    const q = mine.get(i - 1) ? M.compute(m, mine.get(i - 1)) : null;
    const y = mine.get(i - 4) ? M.compute(m, mine.get(i - 4)) : null;
    const sc = new Scale(m.unit, [v], raw);
    let rank_: number | null = null, share: number | null = null;
    if (m.additive && m.kind === "stock") {
      const vals = state.map((g) => M.compute(m, g.per.get(i)) || 0).sort((x, y2) => y2 - x);
      rank_ = 1 + vals.filter((x) => x > v).length;
      let tot = 0;
      for (const x of vals) tot += x;
      share = tot ? pct(v / tot) : null;
    }
    rows.push([m.id, sc.fmt(v), sc.label, pct(growth(v, q)), pct(growth(v, y)), rank_, share]);
  }
  r.add(["metric", "value", "unit", "qoq_%", "yoy_%", `state_rank_of_${state.length}`, "state_share_%"], rows,
    "Key metrics");

  // by line and policy type
  const by = [...(await aggregate(store, cols, ["policy_type"], flt,
    store.idxPeriod.has(i - 1) ? [i, i - 1] : [i])).values()];
  const lines = new Map<string, Map<number, Sums>[]>();
  for (const g of by) {
    const ln = store.policyTypes.get(g.key[0] as string)!.line;
    if (!lines.has(ln)) lines.set(ln, []);
    lines.get(ln)!.push(g.per);
  }
  const mineI = mine.get(i)!;
  const totTiv = M.compute(M.base("tiv"), mineI) || 0;
  const st = new Scale("usd", [M.compute(M.base("tiv"), mineI)], raw);
  const sd = new Scale("usd", [M.compute(M.base("dpw"), mineI)], raw);
  const lrows: Cell[][] = [];
  for (const [ln, pers] of [...lines].sort((x, y) => cmpStr(x[0], y[0]))) {
    const s = combine(pers.map((p) => p.get(i)), cols);
    const sp = combine(pers.map((p) => p.get(i - 1)), cols);
    const tv = s.tiv;
    lrows.push([ln, scInt(s.pif), st.fmt(tv), sd.fmt(s.dpw), totTiv && truthy(tv) ? pct(tv! / totTiv) : null,
      pct(growth(tv, sp.tiv))]);
  }
  r.add(["line", "pif", `tiv (${st.label})`, `dpw (${sd.label})`, "tiv_share_%", "tiv_qoq_%"], lrows, "By line");
  const prow: Cell[][] = [];
  const bySorted = [...by].sort((x, y) => -(x.per.get(i)?.tiv || 0) - -(y.per.get(i)?.tiv || 0));
  for (const g of bySorted) {
    const s = g.per.get(i);
    if (!s || !["pif", "tiv", "dpw"].some((c) => truthy(s[c]))) continue;
    const sp = g.per.get(i - 1) ?? {};
    prow.push([g.key[0] as string, scInt(s.pif), st.fmt(s.tiv), sd.fmt(s.dpw),
      totTiv && truthy(s.tiv) ? pct(s.tiv! / totTiv) : null, pct(growth(s.tiv, sp.tiv)), pct(growth(s.pif, sp.pif))]);
  }
  r.add(["policy_type", "pif", `tiv (${st.label})`, `dpw (${sd.label})`, "tiv_share_%", "tiv_qoq_%", "pif_qoq_%"],
    prow, "By policy type");

  const trows: Cell[][] = [];
  for (const ix of trendIdx) {
    const s = mine.get(ix);
    if (!s) continue;
    trows.push([plabel(ix), scInt(s.pif), st.fmt(s.tiv), sd.fmt(s.dpw), scInt(M.compute(M.derived("net_flow"), s))]);
  }
  r.add(["period", "pif", `tiv (${st.label})`, `dpw (${sd.label})`, "net_flow"], trows, "Trend");

  if (isGroup && store.groups.get(key)!.members.length > 1) {
    const mem = [...(await aggregate(store, cols, ["company"], flt, [i])).values()];
    const mrows = mem.filter((g) => g.per.get(i)).map((g) => {
      const n = g.key[0] as string, s = g.per.get(i)!;
      return [n, store.companies.get(n)!.name, scInt(s.pif), st.fmt(s.tiv), sd.fmt(s.dpw)] as Cell[];
    }).sort((x, y) => -((x[2] as number) || 0) - -((y[2] as number) || 0));
    r.add(["naic", "company", "pif", `tiv (${st.label})`, `dpw (${sd.label})`], mrows, "Members");
  }
  const note = await suppressedNote(store, flt, cols, [i]);
  if (note) r.notes.push(note);
  return r;
}

const OVERVIEW_METRICS = ["pif", "tiv", "dpw", "new_written", "received_in", "cancelled", "nonrenewed", "net_flow",
  "claims_opened", "avg_premium", "premium_per_1k_tiv"];

export async function marketOverview(store: Store, a: Args): Promise<Result> {
  const flt = await makeFilters(store, a);
  const i = parsePeriod(store, a.period, "latest")!;
  const topN = clamp(toInt(a.top_n, 5), 1, 25);
  const raw = !!a.raw;
  const ms = OVERVIEW_METRICS.map(M.get);
  const cols = M.baseDeps(ms);
  const idxs = [i, i - 1, i - 4].filter((ix) => store.idxPeriod.has(ix));
  const byLine = await aggregate(store, cols, ["line"], flt, idxs);
  if (!byLine.size) throw new UserError(`No data for this slice (${flt.describe()}).`);
  const lineGroups = [...byLine.values()];
  const tot = new Map(idxs.map((ix) => [ix, combine(lineGroups.map((g) => g.per.get(ix)), cols)]));
  const split = !flt.line && byLine.size > 1;

  const r = new Result(`Market overview — ${plabel(i)}`);
  r.context.push(`filters: ${flt.describe()}`);
  const rows: Cell[][] = [];
  for (const m of ms) {
    const v = M.compute(m, tot.get(i));
    if (v === null) continue;
    const sc = new Scale(m.unit, [v], raw);
    const row: Cell[] = [m.id, sc.fmt(v), sc.label,
      tot.has(i - 1) ? pct(growth(v, M.compute(m, tot.get(i - 1)))) : null,
      tot.has(i - 4) ? pct(growth(v, M.compute(m, tot.get(i - 4)))) : null];
    if (split) {
      for (const ln of ["commercial", "personal"]) {
        const per = byLine.get(JSON.stringify([ln]))?.per ?? new Map<number, Sums>();
        const lv = per.get(i) ? M.compute(m, per.get(i)) : null;
        row.push(sc.fmt(lv), per.get(i - 1) ? pct(growth(lv, M.compute(m, per.get(i - 1)))) : null);
      }
    }
    rows.push(row);
  }
  r.add(["metric", "value", "unit", "qoq_%", "yoy_%",
    ...(split ? ["commercial", "comm_qoq_%", "personal", "pers_qoq_%"] : [])], rows, "Totals");

  if (store.idxPeriod.has(i - 1)) {
    const mvCols = M.baseDeps([M.base("tiv"), M.base("pif")]);
    const byc = [...(await aggregate(store, mvCols, ["company"], flt, [i, i - 1])).values()];
    for (const mid of ["tiv", "pif"]) {
      const m = M.base(mid);
      const ch: [string, number, number, number][] = [];
      for (const g of byc) {
        const av = g.per.get(i - 1)?.[mid] || 0;
        const bv = g.per.get(i)?.[mid] || 0;
        if (av || bv) ch.push([g.key[0] as string, av, bv, bv - av]);
      }
      ch.sort((x, y) => y[3] - x[3]);
      const head = ch.slice(0, topN);
      const picks = [...head, ...ch.slice(-topN).reverse().filter((x) => x[3] < 0 && !head.includes(x))];
      const sc = new Scale(m.unit, picks.flatMap((p) => [p[1], p[2], p[3]]), raw);
      r.add(["naic", "company", `${plabel(i - 1)} (${sc.label})`, `${plabel(i)} (${sc.label})`, "change", "change_%"],
        picks.map(([n, av, bv, d]) => [n, store.companies.get(n)!.name, sc.fmt(av), sc.fmt(bv), sc.fmt(d),
          pct(growth(bv, av))]),
        `Top ${mid} movers QoQ (gainers then decliners)`);
    }
  }

  const byc = [...(await aggregate(store, ["tiv", "pif", "dpw"], ["company"], flt, [i])).values()];
  const lead = byc.filter((g) => g.per.get(i)).map((g) => [g.key[0] as string, g.per.get(i)!] as const)
    .sort((x, y) => -(x[1].tiv || 0) - -(y[1].tiv || 0)).slice(0, 10);
  const T = tot.get(i)!.tiv || 0;
  const st = new Scale("usd", lead.map((x) => x[1].tiv), raw);
  const sd = new Scale("usd", lead.map((x) => x[1].dpw), raw);
  r.add(["naic", "company", `tiv (${st.label})`, "tiv_share_%", "pif", `dpw (${sd.label})`],
    lead.map(([n, s]) => [n, store.companies.get(n)!.name, st.fmt(s.tiv), T && truthy(s.tiv) ? pct(s.tiv! / T) : null,
      scInt(s.pif), sd.fmt(s.dpw)]), "Largest 10 by TIV");
  return r;
}

export async function findCompanies(store: Store, a: Args): Promise<Result> {
  const q = String(a.query ?? "").trim();
  if (!q) throw new UserError("query is required (company name fragment, group name or NAIC).");
  const limit = clamp(toInt(a.limit, 10), 1, 50);
  const i = parsePeriod(store, a.period, "latest")!;
  let hits = await matchCompanies(store, q);
  if (!hits.length && !isDigits(q)) {
    const toks = tokens(q);
    hits = [...store.companies].filter(([, c]) => {
      const hay = c.names.map(norm).join(" ");
      return toks.some((t) => hay.includes(t));
    }).map(([n]) => n);
  }
  const qt = tokens(q);
  const grpHits = [...store.groups].filter(([, d]) => !d.standalone && qt.every((t) => norm(d.name).includes(t)))
    .map(([g]) => g);
  for (const g of grpHits) for (const n of store.groups.get(g)!.members) if (!hits.includes(n)) hits.push(n);
  const sizeGroups = await aggregate(store, ["pif", "tiv"], ["company"], new Filters(), [i]);
  const size = new Map([...sizeGroups.values()].map((g) => [g.key[0] as string, g.per.get(i)]));
  const ranks = new Map([...size.keys()].sort((x, y) => -(size.get(x)?.pif || 0) - -(size.get(y)?.pif || 0))
    .map((n, k) => [n, k + 1]));
  hits = [...new Set(hits)].sort((x, y) => -(size.get(x)?.tiv || 0) - -(size.get(y)?.tiv || 0)).slice(0, limit);
  if (!hits.length) throw new UserError(`No companies match '${q}'.`);
  const st = new Scale("usd", hits.map((n) => size.get(n)?.tiv ?? null));
  const rows: Cell[][] = hits.map((n) => {
    const c = store.companies.get(n)!;
    const s = size.get(n) ?? {};
    return [n, c.name, c.group_id !== n ? c.group_name : "", c.names.filter((x) => x !== c.name).join(" / "),
      c.first, c.last, scInt(s.pif), st.fmt(s.tiv), ranks.get(n) ?? null];
  });
  const r = new Result(`Companies matching '${q}'`);
  r.context.push(`size columns as of ${plabel(i)}; use the NAIC or exact name in other tools`);
  r.add(["naic", "name", "group", "other_names", "first", "last", "pif", `tiv (${st.label})`, "pif_rank"], rows);
  if (grpHits.length) {
    r.notes.push("Matching groups (use groups=[...]): " + grpHits.map((g) => {
      const d = store.groups.get(g)!;
      return `${d.name} (${d.members.length} NAICs)`;
    }).join("; "));
  }
  return r;
}

// --------------------------------------------------------------------------
// SQL escape hatch
// --------------------------------------------------------------------------

export const SQL_SCHEMA = `Postgres, schema flpc (on the search_path):
facts(period TEXT '2026Q1', idx INT (year*4+q-1), naic TEXT, group_id TEXT, pt_id TEXT, line TEXT 'commercial'|'personal', product TEXT, wind_only INT, <metric columns NUMERIC: pif, pif_incl_wind, pif_excl_wind, tiv, tiv_incl_wind, tiv_excl_wind, dpw, dpw_incl_wind, dpw_excl_wind, new_written, received_in, transferred_out, cancelled, cancelled_hurricane, nonrenewed, nonrenewed_hurricane, claims_*, lawsuits_*>)  -- one row per quarter x company x policy type; NULL = not reported/suppressed
companies(naic, name, names 'A | B', group_id, group_name, first_period, last_period)
groups(group_id, group_name, standalone, members 'naic,naic')
policy_types(pt_id, policy_type, line, product, wind_only)
periods(period, idx, year, quarter, period_end, pulled_at, source_file)
metrics(metric, first_period, last_period, n_periods)
suppressed(period, naic, pt_id, metric)
published_totals(file_type 'A'|'B', period, metric, value)  -- FLOIR 'Total' row
summary_a(period, naic, company, a_pif, a_pif_commercial, a_pif_personal, a_dpw, a_dpw_commercial, a_dpw_personal)`;

const NUMERIC_OIDS = new Set([20, 1700]); // int8, numeric: postgres.js returns these as strings

function sqlCell(v: unknown, oid: number | undefined): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && oid !== undefined && NUMERIC_OIDS.has(oid)) {
    const n = Number(v);
    return Number.isInteger(n) ? n : num(n);
  }
  if (typeof v === "number") return Number.isInteger(v) ? v : num(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Read-only SQL over the flpc tables, run as the flpc_reader role. */
export async function runSql(reader: Db | null, a: Args): Promise<Result> {
  const q = String(a.query ?? "").trim().replace(/;+\s*$/, "");
  if (!q) throw new UserError("query is required.");
  if (!/^\s*(select|with)\b/is.test(q)) throw new UserError("Only SELECT / WITH queries are allowed.");
  if (!reader) throw new UserError("run_sql is not available on this server (no read-only SQL role configured).");
  const limit = clamp(toInt(a.limit, 200), 1, 1000);
  let res: unknown[][] & { columns?: { name: string; type: number }[] };
  try {
    res = await reader.values(`SELECT * FROM (${q}\n) AS _q LIMIT ${limit + 1}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UserError(`SQL error: ${msg}. Schema:\n${SQL_SCHEMA}`);
  }
  const meta = res.columns ?? [];
  const r = new Result("SQL result");
  r.add(meta.map((c) => c.name), res.slice(0, limit).map((row) => row.map((v, j) => sqlCell(v, meta[j]?.type))));
  if (res.length > limit) r.notes.push(`truncated to ${limit} rows`);
  return r;
}

export type { Db };
