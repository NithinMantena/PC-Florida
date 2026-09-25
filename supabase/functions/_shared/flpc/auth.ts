// API tokens: created with flpc.create_token() in the SQL editor, stored as
// sha256 hashes, scoped ('read' = query tools, 'load' = replace the data),
// expiring and revocable. Lookups are cached briefly per function instance.

import type { Db } from "./store.ts";

export interface TokenInfo {
  id: number;
  name: string;
  scopes: string[];
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; info: TokenInfo | null }>();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Token presented as Bearer, X-API-Key or ?key= (the /k/<token>/ prefix is handled by the router). */
export function tokenFrom(req: Request, url: URL): string {
  const auth = req.headers.get("authorization") ?? "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return (req.headers.get("x-api-key") ?? url.searchParams.get("key") ?? "").trim();
}

export async function authenticate(db: Db, token: string): Promise<TokenInfo | null> {
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const hit = cache.get(hash);
  const now = Date.now();
  if (hit && now - hit.at < (hit.info ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit.info;
  const rows = await db.rows<{ id: number; name: string; scopes: string[]; active: boolean; stale: boolean }>(
    `SELECT id::int AS id, name, scopes,
            revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AS active,
            last_used_at IS NULL OR last_used_at < now() - interval '10 minutes' AS stale
       FROM flpc.api_tokens WHERE token_hash = $1`, [hash]);
  const r = rows[0];
  const info = r && r.active ? { id: r.id, name: r.name, scopes: r.scopes } : null;
  if (info && r.stale) await db.rows("UPDATE flpc.api_tokens SET last_used_at = now() WHERE id = $1", [info.id]);
  if (cache.size > 1000) cache.clear();
  cache.set(hash, { at: now, info });
  return info;
}

export function clearTokenCache() {
  cache.clear();
}
