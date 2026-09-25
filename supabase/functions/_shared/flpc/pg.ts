// postgres.js adapter for the Db interface (Deno: npm:postgres via deno.json;
// Node tests: the `postgres` package).

import postgres from "postgres";
import type { Db } from "./store.ts";

export type Sql = ReturnType<typeof postgres>;

export function connect(url: string, opts: Record<string, unknown> = {}): Sql {
  return postgres(url, {
    max: 3,
    prepare: false, // works through Supavisor's transaction pooler too
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    ...opts,
  });
}

/** Extended protocol always (simple: false): one statement per query, never several. */
export function pgDb(sql: Sql): Db {
  return {
    values: (text, params = []) =>
      sql.unsafe(text, params as never[], { simple: false } as never).values() as unknown as Promise<unknown[][]>,
    rows: (text, params = []) =>
      sql.unsafe(text, params as never[], { simple: false } as never) as unknown as Promise<never[]>,
  };
}
