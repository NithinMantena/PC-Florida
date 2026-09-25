// OpenAPI 3.1 description of the REST API, generated from operations.json.
// ChatGPT Custom GPT Actions import it by URL (Authentication: API key, Bearer).

import { OPERATIONS, SERVER } from "./tools.ts";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function openApi(baseUrl: string) {
  const paths: Record<string, unknown> = {};
  for (const o of OPERATIONS) {
    paths[o.rest] = {
      post: {
        operationId: camel(o.name),
        summary: o.summary,
        description: o.description.slice(0, 300),
        parameters: [{
          name: "format", in: "query", required: false,
          description: "json (tables, default) or text (compact CSV)",
          schema: { type: "string", enum: ["json", "text"], default: "json" },
        }],
        requestBody: { required: false, content: { "application/json": { schema: o.inputSchema } } },
        responses: {
          "200": {
            description: "Result tables",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Result" } },
              "text/plain": { schema: { type: "string" } },
            },
          },
          "400": { description: "Bad input (the message explains what to change)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "Missing or bad API token",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Florida P&C Market Data API",
      version: SERVER.version,
      description: SERVER.instructions + "\n\nEvery endpoint accepts `?format=text` for compact CSV output.",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Result: {
          type: "object",
          properties: {
            title: { type: "string" },
            context: { type: "array", items: { type: "string" } },
            tables: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: ["string", "null"] },
                  columns: { type: "array", items: { type: "string" } },
                  rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } },
                },
              },
            },
            notes: { type: "array", items: { type: "string" } },
          },
        },
        Error: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  };
}
