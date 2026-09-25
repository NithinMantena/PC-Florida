// Remote MCP endpoint (Streamable HTTP, stateless, JSON responses): what
// Claude and ChatGPT connectors call from their own clouds. Each POST carries
// one JSON-RPC message (or a batch); no session state is kept, so any function
// instance can answer any request.

import { OPERATIONS, SERVER } from "./tools.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Runs a tool; returns its text, or throws a UserError whose message goes back to the model. */
export type ToolRunner = (name: string, args: unknown) => Promise<string>;

export function toolList() {
  return OPERATIONS.map((o) => ({
    name: o.name,
    description: o.description,
    inputSchema: o.inputSchema,
    annotations: { title: o.summary, readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }));
}

const rpcError = (id: RpcMessage["id"], code: number, message: string) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleOne(msg: RpcMessage, run: ToolRunner): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined;
  const p = msg.params ?? {};
  let result: unknown;
  switch (msg.method) {
    case "initialize": {
      const asked = String(p.protocolVersion ?? "");
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER.name, title: "Florida P&C market data", version: SERVER.version },
        instructions: SERVER.instructions,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: toolList() };
      break;
    case "tools/call": {
      const name = String(p.name ?? "");
      try {
        result = { content: [{ type: "text", text: await run(name, p.arguments ?? {}) }], isError: false };
      } catch (e) {
        if (!(e instanceof Error) || e.name !== "UserError") throw e;
        result = { content: [{ type: "text", text: e.message }], isError: true };
      }
      break;
    }
    case "resources/list":
      result = { resources: [] };
      break;
    case "resources/templates/list":
      result = { resourceTemplates: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    default:
      if (msg.method.startsWith("notifications/")) return null;
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
  return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
}

/** -> [HTTP status, JSON body or null (202 Accepted, nothing to send)] */
export async function handleMcp(body: unknown, run: ToolRunner): Promise<[number, unknown | null]> {
  if (Array.isArray(body)) {
    if (!body.length) return [400, rpcError(null, -32600, "Empty batch")];
    const out = (await Promise.all(body.map((m) => handleOne(m, run)))).filter((x) => x !== null);
    return out.length ? [200, out] : [202, null];
  }
  const res = await handleOne(body as RpcMessage, run);
  return res === null ? [202, null] : [200, res];
}
