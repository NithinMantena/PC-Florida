// Operation dispatch shared by every channel (REST, remote MCP; the local MCP
// server and the OpenClaw CLI reach it over REST). The operation catalog in
// operations.json is the single source of names, descriptions and parameters.

import { getCatalog } from "./catalog.ts";
import * as E from "./engine.ts";
import { type Result, UserError } from "./fmt.ts";
import catalog from "./operations.json" with { type: "json" };
import type { Db, Store } from "./store.ts";

export interface JsonSchema {
  type?: string;
  enum?: string[];
  items?: JsonSchema;
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface Operation {
  name: string;
  rest: string;
  summary: string;
  description: string;
  inputSchema: JsonSchema & { properties: Record<string, JsonSchema> };
}

export const SERVER = catalog.server as { name: string; version: string; instructions: string };
export const OPERATIONS = catalog.operations as Operation[];
export const OPS = new Map(OPERATIONS.map((o) => [o.name, o]));
export const OPS_BY_PATH = new Map(OPERATIONS.map((o) => [o.rest, o]));

type Args = Record<string, unknown>;
type Handler = (store: Store, a: Args, reader: Db | null) => Promise<Result> | Result;

const HANDLERS: Record<string, Handler> = {
  get_catalog: (s) => getCatalog(s),
  find_companies: (s, a) => E.findCompanies(s, a),
  timeseries: (s, a) => E.timeseries(s, a),
  compare_periods: (s, a) => E.comparePeriods(s, a),
  rank: (s, a) => E.rank(s, a),
  company_profile: (s, a) => E.companyProfile(s, a),
  market_overview: (s, a) => E.marketOverview(s, a),
  run_sql: (_s, a, reader) => E.runSql(reader, a),
};

// Common near-misses, applied only when the alias is not itself a parameter.
const ALIASES: Record<string, string> = {
  company: "companies", naic: "companies", naics: "companies", carrier: "companies", carriers: "companies",
  group: "groups", exclude: "exclude_companies", excluded_companies: "exclude_companies",
  metric: "metrics", policy_type: "policy_types", groupby: "group_by", by: "group_by", split_by: "group_by",
  from: "period_from", to: "period_to", start_period: "start", end_period: "end", n: "top_n", top: "top_n",
  quarter: "period", sql: "query", q: "query",
};

/** Validate names and coerce types (REST query strings arrive as text). */
export function normalizeArgs(op: Operation, input: unknown): Args {
  if (input === null || input === undefined) input = {};
  if (typeof input !== "object" || Array.isArray(input)) throw new UserError("arguments must be a JSON object.");
  const props = op.inputSchema.properties;
  const out: Args = {};
  const unknown: string[] = [];
  for (const [k0, v] of Object.entries(input as Args)) {
    if (v === null || v === undefined) continue;
    const k = k0 in props ? k0 : (ALIASES[k0] && ALIASES[k0] in props ? ALIASES[k0] : null);
    if (!k) {
      if (k0 === "format" || k0 === "key") continue; // transport options
      unknown.push(k0);
      continue;
    }
    const t = props[k].type;
    if (t === "boolean") out[k] = E.resolveBool(v);
    else if (t === "integer") {
      if (v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UserError(`'${k}' must be an integer, got '${v}'.`);
      out[k] = Math.trunc(n);
    }
    else out[k] = v;
  }
  if (unknown.length) {
    throw new UserError(`Unknown argument(s) for ${op.name}: ${unknown.join(", ")}. ` +
      `Valid: ${Object.keys(props).join(", ") || "(none)"}.`);
  }
  for (const r of op.inputSchema.required ?? []) {
    if (out[r] === undefined || out[r] === "") throw new UserError(`${op.name} requires '${r}'.`);
  }
  return out;
}

export async function runOperation(store: Store, reader: Db | null, name: string, input: unknown): Promise<Result> {
  const op = OPS.get(name);
  if (!op) throw new UserError(`Unknown tool '${name}'. Available: ${OPERATIONS.map((o) => o.name).join(", ")}.`);
  const args = normalizeArgs(op, input);
  if (name !== "run_sql") await store.ensure();
  return await HANDLERS[name](store, args, reader);
}
