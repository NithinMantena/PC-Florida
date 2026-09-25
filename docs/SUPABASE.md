# Hosting the API on Supabase (shared "reading list" project)

The hosted API is one Supabase Edge Function (`flpc`) plus one Postgres schema
(`flpc`) inside an existing Supabase project. It shares the free-tier project with the
reading list and does not touch the reading list's tables, API or auth.

You need to do this once. Afterwards, adding a quarter is just committing the
workbook to GitHub.

| What it adds to the project | Size |
|---|---|
| Schema `flpc`: data tables, API tokens, load history | about 3 MB of the 500 MB database |
| Role `flpc_reader`: read-only login used only by the `run_sql` tool | — |
| Edge Function `flpc` | 1 function; each call returns 2–8 KB |

The `flpc` schema is not added to the project's exposed API schemas, so the reading
list's anon/authenticated keys cannot see it. Only the function, which connects to
Postgres directly, can read it.

---

## 1. Create the database objects (SQL Editor)

1. Open the reading list project in the Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the whole of [`supabase/flpc.sql`](../supabase/flpc.sql) and press **Run**.
   It is idempotent. Re-run it whenever a newer version of the file is pulled; the
   data and tokens survive.

## 2. Create two API tokens (same SQL Editor)

Each token is shown **once**. Copy it somewhere safe right away. Only a hash is stored.

```sql
select * from flpc.create_token('github-loader', 3650, '{load}');  -- uploads data; used by GitHub
select * from flpc.create_token('chatbots', 365);                   -- read-only; for Claude, ChatGPT, OpenClaw
```

You can make one read token per channel (e.g. `claude`, `chatgpt`, `openclaw`) so each
can be revoked separately. Manage them later with:

```sql
select * from flpc.tokens;                 -- names, scopes, expiry, last used
select flpc.revoke_token('chatbots');      -- takes effect within a minute
```

## 3. Add the GitHub secrets

GitHub → this repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | The reading list project's reference ID: the `xxxx` in `https://supabase.com/dashboard/project/xxxx` (also under Project Settings → General) |
| `SUPABASE_ACCESS_TOKEN` | A personal access token from https://supabase.com/dashboard/account/tokens. It lets GitHub deploy the function. |
| `FLPC_LOAD_TOKEN` | The `github-loader` token from step 2 |

## 4. Deploy and load

GitHub → **Actions → supabase → Run workflow** (on `main`). It:

1. deploys the Edge Function (`supabase functions deploy flpc --no-verify-jwt`), and
2. rebuilds the dataset from every `.xlsx` in the repo and uploads it (`python etl/ingest.py --push`).

Check it: open `https://<project-ref>.supabase.co/functions/v1/flpc/health`. You should
see `"ok": true` and the latest quarter.

After that the workflow runs by itself on every push to `main` that changes a
workbook, the ETL, the carrier groups or the function code.

## 5. Connect your chatbots

See **[INTEGRATIONS.md](INTEGRATIONS.md)**. The base URL is
`https://<project-ref>.supabase.co/functions/v1/flpc`.

---

## Adding a new quarter

1. Download the FLOIR workbook(s) and put them in the repo root (the same folder as the
   other `.xlsx` files).
2. Optional: double-click `update.bat` to refresh the local explorer and read
   `validation_report.txt`.
3. Commit and push to `main`:
   ```powershell
   git add *.xlsx web/data.js
   git commit -m "Add 2026Q2 FLOIR workbooks"
   git push
   ```
   The **supabase** workflow reloads the hosted data. The workflow run also stores
   `validation_report.txt`.

The upload replaces all data tables in one transaction. Readers see the old data until
it commits, and a broken or empty bundle is rejected without touching the loaded
data. A new metric column in a future workbook is added to the table automatically.

## Without GitHub Actions (from your PC)

```powershell
npx supabase login
npx supabase functions deploy flpc --project-ref <project-ref> --no-verify-jwt --use-api
$env:FLPC_URL = "https://<project-ref>.supabase.co/functions/v1/flpc"
$env:FLPC_LOAD_TOKEN = "<github-loader token>"
python etl\ingest.py --push
```

`update.bat` also uploads whenever `FLPC_URL` and `FLPC_LOAD_TOKEN` are set.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/health` says `no data loaded yet` | Run the workflow (or `python etl\ingest.py --push`). |
| `401 unauthorized` | Wrong, revoked or expired token. Check `select * from flpc.tokens;`. |
| `403 ... lacks the 'read' scope` | You used the loader token for queries. Use a read token. |
| `401` with a message about JWT | The function was deployed without `--no-verify-jwt`. Redeploy with it (the workflow does). |
| Deploy step fails on `--use-api` | Old CLI. Remove the flag in `.github/workflows/supabase.yml`, since GitHub runners also have Docker. |
| `run_sql` says it is not available | Re-run `supabase/flpc.sql`. It (re)creates the `flpc_reader` role and its password. |
| Project paused | Free projects can be paused after long inactivity. Restore it in the dashboard; nothing is lost. |

Function logs (Dashboard → Edge Functions → flpc → Logs) have one line per request:
path, tool, token name, channel (`mcp-remote`, `mcp-stdio`, `openclaw`, `rest`),
status and milliseconds. Token values are never logged.
