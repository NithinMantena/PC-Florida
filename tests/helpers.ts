// Test fixtures: a disposable Postgres database set up with supabase/flpc.sql
// and loaded with the bundle the ETL builds (npm run test:prep).
//
// TEST_DATABASE_URL points at a server where we may create databases
// (default: postgres://postgres@127.0.0.1:5432/postgres).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { connect, pgDb, type Sql } from "../supabase/functions/_shared/flpc/pg.ts";

export const REPO = fileURLToPath(new URL("..", import.meta.url)); // ends with a separator
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function bundleText(): string {
  return gunzipSync(readFileSync(`${REPO}data/bundle.json.gz`)).toString("utf8");
}

/** Counts of the loaded bundle, so tests don't break when a quarter is added. */
export function bundleStats(): { facts: number; periods: number; latest: string; previous: string } {
  const b = JSON.parse(bundleText());
  const p = b.tables.periods;
  const col = p.columns.indexOf("period");
  const periods = (p.rows as unknown[][]).map((r) => String(r[col])).sort();
  return {
    facts: b.tables.facts.rows.length,
    periods: periods.length,
    latest: periods[periods.length - 1],
    previous: periods[periods.length - 2],
  };
}

let shared: Promise<{ url: string; sql: Sql }> | null = null;

/** One fresh database per test process, with the schema applied and data loaded. */
export function testDatabase(): Promise<{ url: string; sql: Sql }> {
  shared ??= (async () => {
    const name = `flpc_test_${process.pid}`;
    const admin = connect(ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    for (const r of ["anon", "authenticated"]) {
      await admin.unsafe(`DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }
    await admin.end();
    const url = withDb(ADMIN_URL, name);
    const sql = connect(url);
    await sql.unsafe(readFileSync(`${REPO}supabase/flpc.sql`, "utf8"));
    await pgDb(sql).values("SELECT flpc.load_bundle($1::text::jsonb, 'test')", [bundleText()]);
    return { url, sql };
  })();
  return shared;
}

export async function dropTestDatabase(sql: Sql) {
  const name = `flpc_test_${process.pid}`;
  await sql.end();
  const admin = connect(ADMIN_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
