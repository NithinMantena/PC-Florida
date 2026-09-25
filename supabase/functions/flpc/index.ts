// Supabase Edge Function `flpc`: the hosted Florida P&C data API.
// All logic is in ../_shared/flpc/ (see server.ts for the routes).
//
// Deploy (from the repo root, once per code change; the GitHub workflow
// .github/workflows/supabase.yml does this on every push to main):
//   supabase functions deploy flpc --project-ref <ref> --no-verify-jwt
//
// Environment (provided by Supabase): SUPABASE_URL, SUPABASE_DB_URL.
// Optional secrets: FLPC_PUBLIC_URL (advertised base URL), FLPC_DB_URL
// (overrides SUPABASE_DB_URL, e.g. a pooler connection string).

import { connect, pgDb } from "../_shared/flpc/pg.ts";
import { createHandler, readerFactory } from "../_shared/flpc/server.ts";

const dbUrl = Deno.env.get("FLPC_DB_URL") || Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set");

const db = pgDb(connect(dbUrl));
const baseUrl = (Deno.env.get("FLPC_PUBLIC_URL") ||
  `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/flpc`).replace(/\/+$/, "");

Deno.serve(createHandler({
  db,
  reader: readerFactory(dbUrl, db, (url) => pgDb(connect(url, { max: 1 }))),
  baseUrl,
}));
