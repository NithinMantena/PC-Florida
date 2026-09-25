// Types for flpc-client.mjs.

export interface Operation {
  name: string;
  rest: string;
  summary: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type?: string; description?: string }>; required?: string[] };
}
export declare const catalog: { server: { name: string; version: string; instructions: string }; operations: Operation[] };
export declare const operations: Operation[];
export declare function configPath(): string;
export declare function readConfigFile(): { url?: string; token?: string };
export declare function writeConfigFile(cfg: { url?: string; token?: string }): string;
export declare function resolveConfig(opts?: { url?: string; token?: string }): { url: string; token: string };
export declare class FlpcError extends Error {
  status: number;
  constructor(message: string, status?: number);
}
export declare class FlpcClient {
  url: string;
  token: string;
  channel: string;
  timeoutMs: number;
  constructor(opts?: { url?: string; token?: string; channel?: string; timeoutMs?: number });
  call(name: string, args?: Record<string, unknown>, opts?: { format?: "text" }): Promise<string>;
  // deno-lint-ignore no-explicit-any
  call(name: string, args: Record<string, unknown>, opts: { format: "json" }): Promise<any>;
  health(): Promise<Record<string, unknown>>;
}
