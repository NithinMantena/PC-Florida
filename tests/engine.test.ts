// The hosted engine (TypeScript on Postgres) must answer exactly like the
// local engine (Python on SQLite): same cases, same tables, same numbers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { UserError } from "../supabase/functions/_shared/flpc/fmt.ts";
import { pgDb, type Sql } from "../supabase/functions/_shared/flpc/pg.ts";
import { Store } from "../supabase/functions/_shared/flpc/store.ts";
import { runOperation } from "../supabase/functions/_shared/flpc/tools.ts";
import { dropTestDatabase, REPO, testDatabase } from "./helpers.ts";

let sql: Sql;
let store: Store;

before(async () => {
  ({ sql } = await testDatabase());
  store = new Store(pgDb(sql));
  await store.ensure();
});
after(() => dropTestDatabase(sql));

const cases: [string, Record<string, unknown>][] = JSON.parse(readFileSync(`${REPO}tests/parity_cases.json`, "utf8"));
const expected: ({ ok: unknown } | { error: string })[] = JSON.parse(readFileSync(`${REPO}data/parity.json`, "utf8"));

cases.forEach(([name, args], i) => {
  test(`parity ${i}: ${name} ${JSON.stringify(args)}`, async () => {
    const want = expected[i];
    let got: { ok: unknown } | { error: string };
    try {
      got = { ok: JSON.parse(JSON.stringify((await runOperation(store, null, name, args)).toJSON())) };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      got = { error: e.message };
    }
    // the build timestamp differs between the SQLite and Postgres builds
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/data built [0-9T:-]+/g, "data built <ts>"));
    assert.deepStrictEqual(norm(got), norm(want));
  });
});
