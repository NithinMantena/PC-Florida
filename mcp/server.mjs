#!/usr/bin/env node
// Local MCP server (stdio) for the Florida P&C data: for MCP clients that
// launch a local process or container instead of calling a URL (Claude
// Desktop's config file, Docker's MCP Toolkit, LM Studio, Cursor, ...).
//
// It exposes the same tools as the hosted /mcp endpoint and forwards every
// call to the hosted REST API with the shared client, so domain logic stays
// on the server and nothing touches the database directly.
//
//   FLPC_URL=https://<ref>.supabase.co/functions/v1/flpc FLPC_TOKEN=flpc_... node mcp/server.mjs
//   docker run -i --rm -e FLPC_URL -e FLPC_TOKEN ghcr.io/nithinmantena/pc-florida-mcp

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { catalog, FlpcClient, FlpcError, operations } from "../client/flpc-client.mjs";

const client = new FlpcClient({ channel: "mcp-stdio" });

const server = new Server(
  { name: catalog.server.name, version: catalog.server.version },
  { capabilities: { tools: {} }, instructions: catalog.server.instructions },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: operations.map((o) => ({
    name: o.name,
    description: o.description,
    inputSchema: o.inputSchema,
    annotations: { title: o.summary, readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const text = await client.call(req.params.name, req.params.arguments ?? {}, { format: "text" });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = e instanceof FlpcError ? e.message : `unexpected error: ${e?.message ?? e}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
});

if (!client.url || !client.token) {
  console.error("florida-pc MCP: FLPC_URL / FLPC_TOKEN are not set; tool calls will fail until they are.");
}
await server.connect(new StdioServerTransport());
