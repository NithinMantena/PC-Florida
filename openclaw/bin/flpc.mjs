#!/usr/bin/env node
// flpc: command-line access to the hosted Florida P&C data API, used by the
// OpenClaw skill (openclaw/skills/florida-pc/SKILL.md) and handy on its own.
// Every tool takes the same arguments as the MCP tools and REST endpoints.
//
//   flpc config --url https://<ref>.supabase.co/functions/v1/flpc --token flpc_...
//   flpc health
//   flpc tools                                     list tools and their parameters
//   flpc rank --metric tiv --top_n 10 --exclude_companies Citizens
//   flpc timeseries --metrics tiv,pif --line commercial --transform yoy
//   flpc compare_periods '{"metric":"tiv","companies":["American Integrity"],"group_by":"policy_type"}'
//   flpc market_overview --json                    JSON tables instead of CSV text

import { configPath, FlpcClient, FlpcError, operations, readConfigFile, writeConfigFile } from "../../client/flpc-client.mjs";

const USAGE = `usage: flpc <tool> [--param value ...] ['{"json":"args"}'] [--json]
       flpc tools | flpc health | flpc config --url URL --token TOKEN
tools: ${operations.map((o) => o.name).join(", ")}`;

/** --key value / --key=value / --flag pairs, plus at most one JSON object argument. */
function parseArgs(argv) {
  const out = {};
  let json = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replaceAll("-", "_");
      let val;
      if (key === "json") val = true; // output switch, never takes a value
      else if (eq > 0) val = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
      else val = true;
      out[key] = key in out ? [].concat(out[key], val) : val;
    } else if (a.trim().startsWith("{")) {
      try {
        json = JSON.parse(a);
      } catch (e) {
        throw new FlpcError(`bad JSON argument: ${e.message}`, 2);
      }
    } else {
      throw new FlpcError(`unexpected argument '${a}'\n${USAGE}`, 2);
    }
  }
  return { flags: out, json };
}

/** Type flag values by the tool's schema (lists split on commas unless a name needs them). */
function typed(op, flags) {
  const props = op.inputSchema.properties;
  const args = {};
  for (const [k, v] of Object.entries(flags)) {
    const t = props[k]?.type;
    if (t === "integer") args[k] = Number(v);
    else if (t === "boolean") args[k] = v === true || /^(true|yes|1)$/i.test(String(v));
    else if (t === "array") args[k] = Array.isArray(v) ? v : String(v); // the server splits strings sensibly
    else args[k] = v;
  }
  return args;
}

function describeTools() {
  const lines = [];
  for (const o of operations) {
    const props = o.inputSchema.properties;
    const req = new Set(o.inputSchema.required ?? []);
    const params = Object.entries(props).map(([k, p]) => `${req.has(k) ? "" : "["}--${k} <${p.type}>${req.has(k) ? "" : "]"}`);
    lines.push(`${o.name}: ${o.summary}`, `  ${params.join(" ") || "(no parameters)"}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "tools") {
    console.log(describeTools());
    return 0;
  }
  if (cmd === "config") {
    const { flags } = parseArgs(rest);
    const cfg = { ...readConfigFile(), ...(flags.url ? { url: String(flags.url).replace(/\/+$/, "") } : {}),
      ...(flags.token ? { token: String(flags.token) } : {}) };
    if (flags.url || flags.token) console.log(`saved ${writeConfigFile(cfg)}`);
    console.log(`url:   ${cfg.url ?? "(not set)"}\ntoken: ${cfg.token ? cfg.token.slice(0, 9) + "…" : "(not set)"}` +
      `\nfile:  ${configPath()}  (FLPC_URL / FLPC_TOKEN override it)`);
    return 0;
  }
  const client = new FlpcClient({ channel: "openclaw" });
  if (cmd === "health") {
    console.log(JSON.stringify(await client.health(), null, 2));
    return 0;
  }
  const op = operations.find((o) => o.name === cmd);
  if (!op) throw new FlpcError(`unknown tool '${cmd}'\n${USAGE}`, 2);
  const { flags, json } = parseArgs(rest);
  const asJson = flags.json === true;
  delete flags.json;
  const args = { ...(json ?? {}), ...typed(op, flags) };
  const out = await client.call(op.name, args, { format: asJson ? "json" : "text" });
  console.log(asJson ? JSON.stringify(out, null, 2) : out.trimEnd());
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof FlpcError ? `flpc: ${e.message}` : e);
  process.exit(e instanceof FlpcError && e.status === 2 ? 2 : 1);
});
