// The local channels against a real HTTP server running the hosted handler:
// the shared client, the OpenClaw CLI, and the stdio MCP server (driven by
// the official MCP SDK client, as Claude Desktop would).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FlpcClient } from "../client/flpc-client.mjs";
import { clearTokenCache } from "../supabase/functions/_shared/flpc/auth.ts";
import { pgDb, type Sql } from "../supabase/functions/_shared/flpc/pg.ts";
import { createHandler } from "../supabase/functions/_shared/flpc/server.ts";
import { dropTestDatabase, REPO, testDatabase } from "./helpers.ts";

const run = promisify(execFile);
let sql: Sql;
let http: Server;
let base: string;
let token: string;

before(async () => {
  ({ sql } = await testDatabase());
  token = (await sql.unsafe("SELECT token FROM flpc.create_token('channels', 1)"))[0].token as string;
  clearTokenCache();
  const handle = createHandler({ db: pgDb(sql), reader: async () => null, baseUrl: "http://x", log: () => {} });
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await handle(new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks),
    }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/flpc`;
});
after(async () => {
  await new Promise((ok) => http.close(ok));
  await dropTestDatabase(sql);
});

const env = () => ({ ...process.env, FLPC_URL: base, FLPC_TOKEN: token, XDG_CONFIG_HOME: "/nonexistent" });

test("shared client: text and json", async () => {
  const c = new FlpcClient({ url: base, token });
  const t = await c.call("rank", { metric: "pif", top_n: 2 });
  assert.match(t, /^## Policies in force ranking by company/);
  const j = await c.call("rank", { metric: "pif", top_n: 2 }, { format: "json" });
  assert.equal(j.tables[0].rows.length, 3);
  await assert.rejects(c.call("rank", { metric: "nope" }), /Unknown metric/);
  await assert.rejects(new FlpcClient({ url: base, token: "bad" }).call("get_catalog"), /unauthorized/);
});

test("OpenClaw CLI: flags, JSON argument, errors", async () => {
  const cli = `${REPO}openclaw/bin/flpc.mjs`;
  const a = await run("node", [cli, "timeseries", "--metrics", "tiv,pif", "--start", "latest-1", "--line", "personal"], { env: env() });
  assert.match(a.stdout, /TIV \/ exposure, Policies in force/);
  assert.match(a.stdout, /line=personal/);
  const b = await run("node", [cli, "rank", '{"metric":"dpw","top_n":1}', "--json"], { env: env() });
  assert.equal(JSON.parse(b.stdout).tables[0].rows.length, 2);
  await assert.rejects(run("node", [cli, "rank", "--metric", "nope"], { env: env() }),
    (e: { stderr: string; code: number }) => /Unknown metric/.test(e.stderr) && e.code === 1);
  const h = await run("node", [cli, "tools"], { env: env() });
  assert.match(h.stdout, /compare_periods: /);
});

test("stdio MCP server via the official SDK client", async () => {
  const transport = new StdioClientTransport({ command: "node", args: [`${REPO}mcp/server.mjs`], env: env() });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const r = await client.callTool({ name: "company_profile", arguments: { company: "Citizens" } });
    assert.ok(!r.isError);
    assert.match((r.content as { text: string }[])[0].text, /^## Profile: CITIZENS/);
    const bad = await client.callTool({ name: "rank", arguments: { metric: "tiv", colour: "red" } });
    assert.equal(bad.isError, true);
    assert.match((bad.content as { text: string }[])[0].text, /Unknown argument/);
  } finally {
    await client.close();
  }
});
