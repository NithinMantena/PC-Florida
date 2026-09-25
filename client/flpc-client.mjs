// Shared client for the hosted Florida P&C API, used by the local MCP server
// (mcp/server.mjs) and the OpenClaw CLI (openclaw/bin/flpc.mjs). Plain
// JavaScript with no dependencies, so it runs on any Node >= 18 without a build.
//
// Configuration (first match wins):
//   1. options passed to new FlpcClient({ url, token })
//   2. environment: FLPC_URL, FLPC_TOKEN
//   3. config file written by `flpc config --url ... --token ...`:
//        Windows: %APPDATA%\flpc\config.json   others: ~/.config/flpc/config.json

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, "..", "supabase", "functions", "_shared", "flpc", "operations.json");

/** The operation catalog shared with the server: names, descriptions, JSON Schemas. */
export const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
export const operations = catalog.operations;

export function configPath() {
  const base = process.platform === "win32"
    ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "flpc", "config.json");
}

export function readConfigFile() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfigFile(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // not supported on every filesystem
  }
  return p;
}

export function resolveConfig(opts = {}) {
  const file = readConfigFile();
  const url = (opts.url ?? process.env.FLPC_URL ?? file.url ?? "").replace(/\/+$/, "");
  const token = opts.token ?? process.env.FLPC_TOKEN ?? file.token ?? "";
  return { url, token };
}

export class FlpcError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FlpcError";
    this.status = status;
  }
}

export class FlpcClient {
  /** @param {{url?: string, token?: string, channel?: string, timeoutMs?: number}} opts */
  constructor(opts = {}) {
    const { url, token } = resolveConfig(opts);
    this.url = url;
    this.token = token;
    this.channel = opts.channel ?? "client";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  assertConfigured() {
    if (!this.url || !this.token) {
      throw new FlpcError("not configured: set FLPC_URL and FLPC_TOKEN, or run `flpc config --url <url> --token <token>`");
    }
  }

  async request(path, { method = "GET", body, format } = {}) {
    this.assertConfigured();
    const u = new URL(this.url + path);
    if (format) u.searchParams.set("format", format);
    let res;
    try {
      res = await fetch(u, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-flpc-channel": this.channel,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FlpcError(`cannot reach ${this.url}: ${e.message ?? e}`, 0);
    }
    const textBody = await res.text();
    if (!res.ok) {
      let msg = textBody;
      try {
        msg = JSON.parse(textBody).error ?? textBody;
      } catch {
        // not JSON
      }
      throw new FlpcError(msg || `HTTP ${res.status}`, res.status);
    }
    return textBody;
  }

  /**
   * Run one operation (tool) by name.
   * @param {string} name   e.g. "rank"
   * @param {object} args   e.g. { metric: "tiv", top_n: 10 }
   * @param {{format?: "text"|"json"}} opts  text = compact CSV (default), json = tables
   */
  async call(name, args = {}, { format = "text" } = {}) {
    const op = operations.find((o) => o.name === name);
    if (!op) throw new FlpcError(`unknown operation '${name}'. Available: ${operations.map((o) => o.name).join(", ")}`, 400);
    const out = await this.request(op.rest, { method: "POST", body: args, format });
    return format === "json" ? JSON.parse(out) : out;
  }

  async health() {
    if (!this.url) this.assertConfigured();
    const res = await fetch(new URL(this.url + "/health"), { signal: AbortSignal.timeout(this.timeoutMs) });
    return await res.json();
  }
}
