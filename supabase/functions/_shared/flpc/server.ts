// HTTP entry point of the hosted API (Supabase Edge Function `flpc`).
//
//   /mcp            remote MCP (Claude / ChatGPT connectors, Claude Code, any MCP client)
//   /api/<tool>     REST, JSON or ?format=text (Custom GPT Actions, scripts, local MCP, OpenClaw)
//   /openapi.json   OpenAPI 3.1 for Custom GPTs            (no token needed)
//   /health         loaded data summary                    (no token needed)
//   /admin/load     replace the data (token with the 'load' scope; used by the ETL / GitHub Action)
//
// A token goes in `Authorization: Bearer`, `X-API-Key`, `?key=`, or a
// `/k/<token>/` path prefix (for connectors that only take a URL).

import { authenticate, type TokenInfo, tokenFrom } from "./auth.ts";
import { Result, UserError } from "./fmt.ts";
import { handleMcp } from "./mcp.ts";
import { openApi } from "./openapi.ts";
import { type Db, Store } from "./store.ts";
import { OPERATIONS, OPS, OPS_BY_PATH, runOperation, SERVER } from "./tools.ts";

export interface AppDeps {
  /** Owner connection: tools, token checks, data loads. */
  db: Db;
  /** Read-only connection for run_sql (flpc_reader role), or null when unavailable. */
  reader: () => Promise<Db | null>;
  /** Public base URL of this API, e.g. https://<ref>.supabase.co/functions/v1/flpc */
  baseUrl: string;
  log?: (entry: Record<string, unknown>) => void;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-api-key, content-type, content-encoding, mcp-protocol-version, " +
    "mcp-session-id, x-flpc-channel",
  "access-control-expose-headers": "mcp-session-id",
};

const MAX_LOAD_BYTES = 50 * 1024 * 1024;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
}

const unauthorized = () =>
  json(401, { error: "unauthorized: missing or bad API token" }, { "www-authenticate": "Bearer" });

async function readBody(req: Request): Promise<Uint8Array> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_LOAD_BYTES) throw new UserError("request body too large");
  if (buf[0] === 0x1f && buf[1] === 0x8b) { // gzip, whether or not a proxy already decoded the header
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buf;
}

async function jsonBody(req: Request): Promise<unknown> {
  const raw = new TextDecoder().decode(await readBody(req)).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new UserError("request body must be JSON");
  }
}

/** GET query string -> arguments (repeated keys become lists). */
function queryArgs(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set(url.searchParams.keys())) {
    if (k === "format" || k === "key") continue;
    const vs = url.searchParams.getAll(k);
    out[k] = vs.length > 1 ? vs : vs[0];
  }
  return out;
}

export function createHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  const store = new Store(deps.db);
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));

  const run = async (name: string, args: unknown): Promise<Result> => {
    const reader = name === "run_sql" ? await deps.reader() : null;
    return await runOperation(store, reader, name, args);
  };

  async function health(): Promise<Response> {
    try {
      await store.ensure();
      return json(200, {
        ok: true, latest_period: store.periods[store.periods.length - 1][0], periods: store.periods.length,
        companies: store.companies.size, built: store.meta.generated_at ?? null, loaded_at: store.meta.loaded_at ?? null,
      });
    } catch (e) {
      return json(503, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function load(req: Request, token: TokenInfo): Promise<Response> {
    const body = new TextDecoder().decode(await readBody(req));
    if (!body.trimStart().startsWith("{")) throw new UserError("load body must be a JSON bundle (etl/ingest.py --push)");
    let res: unknown;
    try {
      const rows = await deps.db.rows<{ r: unknown }>("SELECT flpc.load_bundle($1::text::jsonb, $2) AS r",
        [body, token.name]);
      res = rows[0].r;
    } catch (e) {
      throw new UserError(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    store.invalidate();
    await store.ensure(true);
    return json(200, res);
  }

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    // Supabase routes /functions/v1/flpc/... to this function as /flpc/...
    let path = url.pathname.replace(/^\/functions\/v1(?=\/)/, "").replace(/^\/flpc(?=\/|$)/, "") || "/";
    let token = "";
    const k = /^\/k\/([^/]+)(\/.*)?$/.exec(path);
    if (k) {
      token = decodeURIComponent(k[1]);
      path = k[2] || "/";
    } else token = tokenFrom(req, url);
    path = path.length > 1 ? path.replace(/\/+$/, "") : path;

    const entry: Record<string, unknown> = { method: req.method, path };
    const done = (res: Response) => {
      entry.status = res.status;
      entry.ms = Date.now() - t0;
      log(entry);
      return res;
    };

    try {
      if (req.method === "OPTIONS") return done(new Response(null, { status: 204, headers: CORS }));
      if (path === "/" && req.method === "GET") {
        return done(json(200, {
          name: SERVER.name, version: SERVER.version, mcp: `${deps.baseUrl}/mcp`, rest: `${deps.baseUrl}/api`,
          openapi: `${deps.baseUrl}/openapi.json`, health: `${deps.baseUrl}/health`,
        }));
      }
      if (path === "/health") return done(await health());
      if (path === "/openapi.json") return done(json(200, openApi(deps.baseUrl)));

      const known = path === "/mcp" || path === "/api" || path === "/admin/load" || OPS_BY_PATH.has(path) ||
        (path.startsWith("/api/") && OPS.has(path.slice(5)));
      if (!known) return done(json(404, { error: `not found: ${path}` }));

      const who = await authenticate(deps.db, token);
      if (!who) return done(unauthorized());
      entry.token = who.name;
      entry.channel = req.headers.get("x-flpc-channel") ?? (path === "/mcp" ? "mcp-remote" : "rest");
      const need = path === "/admin/load" ? "load" : "read";
      if (!who.scopes.includes(need)) return done(json(403, { error: `this token lacks the '${need}' scope` }));

      if (path === "/admin/load") {
        if (req.method !== "POST") return done(json(405, { error: "POST a bundle" }, { allow: "POST" }));
        return done(await load(req, who));
      }

      if (path === "/mcp") {
        if (req.method !== "POST") {
          return done(json(405, { error: "this MCP endpoint is stateless: POST JSON-RPC messages" }, { allow: "POST" }));
        }
        const body = await jsonBody(req);
        const calls: string[] = [];
        const [status, out] = await handleMcp(body, async (name, args) => {
          calls.push(name);
          try {
            return (await run(name, args)).toText();
          } catch (e) {
            if (e instanceof UserError) throw e;
            console.error(e);
            throw new UserError(`internal error while running ${name}; try again or simplify the request`);
          }
        });
        if (calls.length) entry.op = calls.join(",");
        return done(out === null ? new Response(null, { status, headers: CORS }) : json(status, out));
      }

      if (path === "/api") {
        return done(json(200, {
          operations: OPERATIONS.map((o) => ({ name: o.name, path: o.rest, summary: o.summary })),
        }));
      }

      const op = OPS_BY_PATH.get(path) ?? OPS.get(path.slice(5))!;
      entry.op = op.name;
      if (req.method !== "GET" && req.method !== "POST") return done(json(405, { error: "use GET or POST" }));
      const args = req.method === "POST" ? await jsonBody(req) : queryArgs(url);
      const res = await run(op.name, args);
      const format = url.searchParams.get("format") ?? "json";
      return done(format === "text" ? text(200, res.toText()) : json(200, res.toJSON()));
    } catch (e) {
      if (e instanceof UserError) {
        entry.error = e.message.slice(0, 200);
        return done(json(400, { error: e.message }));
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e);
      if (!store.loaded && /no data loaded/.test(msg)) return done(json(503, { error: msg }));
      entry.error = msg.slice(0, 200);
      return done(json(500, { error: "internal error" }));
    }
  };
}

/**
 * Lazily connects as flpc_reader for run_sql. Its random password lives in
 * flpc.secrets (set by supabase/flpc.sql); the user name follows the owner
 * URL's form (`postgres` -> `flpc_reader`, pooler `postgres.<ref>` -> `flpc_reader.<ref>`).
 */
export function readerFactory(ownerUrl: string, db: Db, open: (url: string) => Db & { end?: () => Promise<void> }) {
  let current: Promise<Db | null> | null = null;
  return (): Promise<Db | null> => {
    current ??= (async () => {
      const rows = await db.rows<{ value: string }>("SELECT value FROM flpc.secrets WHERE key = 'reader_password'");
      if (!rows.length) return null;
      const u = new URL(ownerUrl);
      const suffix = decodeURIComponent(u.username).includes(".")
        ? decodeURIComponent(u.username).slice(decodeURIComponent(u.username).indexOf("."))
        : "";
      u.username = encodeURIComponent(`flpc_reader${suffix}`);
      u.password = encodeURIComponent(rows[0].value);
      const conn = open(u.toString());
      // a failed login (e.g. password rotated by re-running flpc.sql) retries on the next call
      const wrap = (fn: (t: string, p?: unknown[]) => Promise<unknown>) => async (t: string, p?: unknown[]) => {
        try {
          return await fn(t, p);
        } catch (e) {
          if (/password authentication failed|role .* does not exist/i.test(String(e))) current = null;
          throw e;
        }
      };
      return { values: wrap(conn.values), rows: wrap(conn.rows) } as Db;
    })().catch((e) => {
      current = null;
      console.error("run_sql reader unavailable:", e);
      return null;
    });
    return current;
  };
}
