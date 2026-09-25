// Test fixtures: a disposable Postgres database set up with supabase/flpc.sql
// and loaded with the bundle the ETL builds (npm run test:prep).
//
// TEST_DATABASE_URL points at a server where we may create databases
// (default: postgres://postgres@127.0.0.1:5432/postgres).

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { connect, pgDb, type Sql } from "../supabase/functions/_shared/flpc/pg.ts";

export const REPO = new URL("..", import.meta.url).pathname;
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function bundleText(): string {
  return gunzipSync(readFileSync(`${REPO}data/bundle.json.gz`)).toString("utf8");
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
