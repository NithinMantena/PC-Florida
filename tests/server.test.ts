// HTTP behaviour of the hosted API: auth and scopes, REST, remote MCP,
// OpenAPI, data loads, and the run_sql lockdown.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { clearTokenCache } from "../supabase/functions/_shared/flpc/auth.ts";
import { connect, pgDb, type Sql } from "../supabase/functions/_shared/flpc/pg.ts";
import { createHandler, readerFactory } from "../supabase/functions/_shared/flpc/server.ts";
import { dropTestDatabase, REPO, testDatabase } from "./helpers.ts";

let sql: Sql;
let handle: (req: Request) => Promise<Response>;
let readToken: string;
let loadToken: string;
const readers: Sql[] = [];
const BASE = "https://example.supabase.co/functions/v1/flpc";

before(async () => {
  let url: string;
  ({ sql, url } = await testDatabase());
  const db = pgDb(sql);
  const mk = async (name: string, scopes: string) =>
    (await sql.unsafe(`SELECT token FROM flpc.create_token('${name}', 30, '${scopes}')`))[0].token as string;
  await sql.unsafe("DELETE FROM flpc.api_tokens");
  readToken = await mk("t-read", "{read}");
  loadToken = await mk("t-load", "{load}");
  clearTokenCache();
  handle = createHandler({
    db,
    baseUrl: BASE,
    log: () => {},
    reader: readerFactory(url, db, (u) => {
      const s = connect(u, { max: 1 });
      readers.push(s);
      return pgDb(s);
    }),
  });
});
after(async () => {
  for (const r of readers) await r.end();
  await dropTestDatabase(sql);
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return handle(new Request(`http://localhost/flpc${path}`, { ...init, headers }));
};
const post = (path: string, body: unknown, token = readToken) =>
  call(path, { method: "POST", body: JSON.stringify(body), token, headers: { "content-type": "application/json" } });
const rpc = async (body: unknown, token = readToken) => {
  const r = await post("/mcp", body, token);
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};

describe("open endpoints", () => {
  test("health reports the loaded data", async () => {
    const r = await call("/health");
    assert.equal(r.status, 200);
    const h = await r.json();
    assert.equal(h.ok, true);
    assert.equal(h.latest_period, "2026Q1");
    assert.equal(h.periods, 16);
  });
  test("openapi lists every operation with the public server URL", async () => {
    const spec = await (await call("/openapi.json")).json();
    assert.equal(spec.servers[0].url, BASE);
    assert.deepEqual(Object.keys(spec.paths).sort(), [
      "/api/catalog", "/api/company_profile", "/api/compare_periods", "/api/find_companies", "/api/market_overview",
      "/api/rank", "/api/sql", "/api/timeseries"]);
    for (const p of Object.values(spec.paths) as { post: { description: string } }[]) {
      assert.ok(p.post.description.length <= 300);
    }
  });
  test("unknown paths are 404 without a token check", async () => {
    assert.equal((await call("/nope")).status, 404);
  });
});

describe("auth", () => {
  test("no token, bad token -> 401", async () => {
    assert.equal((await post("/api/catalog", {}, "")).status, 401);
    assert.equal((await post("/api/catalog", {}, "flpc_wrong")).status, 401);
    assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, "")).status, 401);
  });
  test("token via X-API-Key, ?key= and /k/<token>/ prefix", async () => {
    assert.equal((await call("/api/catalog", { headers: { "x-api-key": readToken } })).status, 200);
    assert.equal((await call(`/api/catalog?key=${readToken}`)).status, 200);
    assert.equal((await call(`/k/${readToken}/api/catalog`)).status, 200);
    const r = await handle(new Request(`http://localhost/flpc/k/${readToken}/mcp`, {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    assert.equal(r.status, 200);
  });
  test("scopes: a load token cannot query, a read token cannot load", async () => {
    assert.equal((await post("/api/catalog", {}, loadToken)).status, 403);
    assert.equal((await post("/admin/load", {}, readToken)).status, 403);
  });
  test("revoked and expired tokens stop working", async () => {
    const t = (await sql.unsafe("SELECT token FROM flpc.create_token('t-tmp', 30)"))[0].token as string;
    assert.equal((await post("/api/catalog", {}, t)).status, 200);
    await sql.unsafe("SELECT flpc.revoke_token('t-tmp')");
    clearTokenCache();
    assert.equal((await post("/api/catalog", {}, t)).status, 401);
    const e = (await sql.unsafe("SELECT token FROM flpc.create_token('t-exp', 30)"))[0].token as string;
    await sql.unsafe("UPDATE flpc.api_tokens SET expires_at = now() - interval '1 second' WHERE name = 't-exp'");
    assert.equal((await post("/api/catalog", {}, e)).status, 401);
  });
  test("last_used_at is recorded", async () => {
    const r = await sql.unsafe("SELECT last_used_at FROM flpc.api_tokens WHERE name = 't-read'");
    assert.ok(r[0].last_used_at);
  });
});

describe("REST", () => {
  test("POST json", async () => {
    const r = await post("/api/rank", { metric: "tiv", top_n: 3 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.title, /ranking by company/);
    assert.equal(j.tables[0].rows.length, 4); // 3 + total
  });
  test("GET with query args and ?format=text", async () => {
    const r = await call("/api/timeseries?metrics=pif&start=2025Q4&format=text", { token: readToken });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/plain/);
    const t = await r.text();
    assert.match(t, /^## Policies in force/);
    assert.match(t, /2025Q4,2026Q1/);
  });
  test("integer and boolean query strings are coerced", async () => {
    const j = await (await call("/api/rank?metric=tiv&top_n=2&raw=false&ascending=true", { token: readToken })).json();
    assert.equal(j.tables[0].rows.length, 3);
  });
  test("bad input -> 400 with a helpful message", async () => {
    const r = await post("/api/rank", { metric: "nope" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Unknown metric 'nope'/);
  });
  test("misspelled argument names are mapped or rejected, never silently ignored", async () => {
    const ok = await (await post("/api/rank", { metric: "tiv", company: "Citizens" })).json();
    assert.match(ok.context[0], /companies=CITIZENS/i);
    const bad = await post("/api/rank", { metric: "tiv", colour: "red" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Unknown argument\(s\) for rank: colour/);
  });
  test("required arguments", async () => {
    const r = await post("/api/timeseries", {});
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /requires 'metrics'/);
  });
});

describe("remote MCP", () => {
  test("initialize negotiates the protocol version", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(body.result.protocolVersion, "2025-06-18");
    assert.equal(body.result.serverInfo.name, "florida-pc");
    assert.ok(body.result.capabilities.tools);
    const { body: b2 } = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999" } });
    assert.equal(b2.result.protocolVersion, "2025-11-25");
  });
  test("notifications get 202 and no body", async () => {
    const r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(r.status, 202);
  });
  test("tools/list has all 8 read-only tools", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = body.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["get_catalog", "find_companies", "timeseries", "compare_periods", "rank",
      "company_profile", "market_overview", "run_sql"]);
    for (const t of body.result.tools) assert.equal(t.annotations.readOnlyHint, true);
  });
  test("tools/call returns CSV text", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "market_overview", arguments: { top_n: 2 } } });
    assert.equal(body.result.isError, false);
    assert.match(body.result.content[0].text, /^## Market overview — 2026Q1/);
  });
  test("tool errors come back as isError results the model can read", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "company_profile", arguments: { company: "universl property" } } });
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Did you mean/);
  });
  test("batches and unknown methods", async () => {
    const { body } = await rpc([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", id: 7, method: "nope" },
      { jsonrpc: "2.0", method: "notifications/x" }]);
    assert.equal(body.length, 2);
    assert.deepEqual(body[0], { jsonrpc: "2.0", id: 6, result: {} });
    assert.equal(body[1].error.code, -32601);
  });
  test("GET /mcp is 405 (stateless server, no SSE stream)", async () => {
    assert.equal((await call("/mcp", { token: readToken })).status, 405);
  });
});

describe("run_sql", () => {
  const q = async (query: string) => {
    const r = await post("/api/sql", { query });
    return { status: r.status, body: await r.json() };
  };
  test("reads the data tables", async () => {
    const { status, body } = await q("select period, count(*) n, sum(tiv) tiv from facts group by period order by period");
    assert.equal(status, 200);
    assert.deepEqual(body.tables[0].columns, ["period", "n", "tiv"]);
    assert.equal(body.tables[0].rows.length, 16);
    assert.equal(typeof body.tables[0].rows[0][1], "number");
    const naic = await q("select naic from companies where naic = '10064'");
    assert.deepEqual(naic.body.tables[0].rows, [["10064"]]); // text stays text
  });
  test("cannot see tokens, secrets or other schemas", async () => {
    for (const t of ["flpc.api_tokens", "flpc.secrets", "flpc.loads", "pg_authid"]) {
      const { status, body } = await q(`select * from ${t}`);
      assert.equal(status, 400, t);
      assert.match(body.error, /permission denied/, t);
    }
  });
  test("cannot write, chain statements or switch roles", async () => {
    let r = await q("with d as (delete from facts returning 1) select count(*) from d");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /data-modifying|read-only|permission denied/);
    r = await q("select 1; delete from facts");
    assert.equal(r.status, 400);
    r = await q("select set_config('role', 'postgres', true), (select count(*) from flpc.api_tokens)");
    assert.equal(r.status, 400);
    r = await q("select set_config('role', 'postgres', false), query_to_xml('select * from flpc.api_tokens', true, true, '')");
    assert.equal(r.status, 400);
    r = await q("update facts set tiv = 0");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Only SELECT/);
    const n = await sql.unsafe("SELECT count(*)::int AS n FROM flpc.facts WHERE tiv = 0");
    assert.ok(n[0].n < 7000);
  });
  test("the reader role itself is read-only, whatever the query text", async () => {
    const u = new URL((await testDatabase()).url);
    u.username = "flpc_reader";
    const r = connect(u.toString(), { max: 1 });
    readers.push(r);
    await assert.rejects(r.unsafe("DELETE FROM flpc.facts"), /read-only|permission denied/);
    // even in an explicitly read-write transaction it has no write privileges
    await assert.rejects(r.begin("read write", (tx) => tx.unsafe("DELETE FROM flpc.facts")), /permission denied/);
    await assert.rejects(r.unsafe("SET ROLE postgres"), /permission denied/);
    await assert.rejects(r.unsafe("SELECT * FROM flpc.api_tokens"), /permission denied/);
    const ok = await r.unsafe("SELECT count(*)::int AS n FROM facts");
    assert.equal(ok[0].n, 7367);
  });
  test("rows are capped", async () => {
    const r = await post("/api/sql", { query: "select * from facts", limit: 5 });
    const j = await r.json();
    assert.equal(j.tables[0].rows.length, 5);
    assert.deepEqual(j.notes, ["truncated to 5 rows"]);
  });
});

describe("data load", () => {
  test("gzip bundle replaces the data atomically and bumps load_id", async () => {
    const before = (await sql.unsafe("SELECT value FROM flpc.meta WHERE key = 'load_id'"))[0].value;
    const r = await call("/admin/load", {
      method: "POST", token: loadToken, body: readFileSync(`${REPO}data/bundle.json.gz`),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.equal(j.rows.facts, 7367);
    assert.equal(j.latest_period, "2026Q1");
    const afterId = (await sql.unsafe("SELECT value FROM flpc.meta WHERE key = 'load_id'"))[0].value;
    assert.notEqual(afterId, before);
    const loads = await sql.unsafe("SELECT token_name FROM flpc.loads ORDER BY loaded_at DESC LIMIT 1");
    assert.equal(loads[0].token_name, "t-load");
  });
  test("a bad bundle is rejected and the data stays", async () => {
    const r = await call("/admin/load", { method: "POST", token: loadToken, body: JSON.stringify({ format: 1, tables: {} }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /missing table/);
    const empty = { format: 1, tables: Object.fromEntries(["meta", "periods", "companies", "groups", "policy_types",
      "metrics", "facts", "suppressed", "published_totals", "summary_a"].map((t) => [t, { columns: [], rows: [] }])) };
    const r2 = await call("/admin/load", { method: "POST", token: loadToken, body: JSON.stringify(empty) });
    assert.equal(r2.status, 400);
    assert.match((await r2.json()).error, /refusing to replace/);
    const n = await sql.unsafe("SELECT count(*)::int AS n FROM flpc.facts");
    assert.equal(n[0].n, 7367);
  });
  test("a new metric column in a future workbook is added automatically", async () => {
    const b = JSON.parse(new TextDecoder().decode(
      (await import("node:zlib")).gunzipSync(readFileSync(`${REPO}data/bundle.json.gz`))));
    b.tables.facts.columns.push("claims_reopened");
    for (const row of b.tables.facts.rows) row.push(1);
    const r = await call("/admin/load", { method: "POST", token: loadToken, body: JSON.stringify(b) });
    assert.equal(r.status, 200, await r.clone().text());
    const s = await sql.unsafe("SELECT sum(claims_reopened)::int AS n FROM flpc.facts");
    assert.equal(s[0].n, 7367);
  });
});
