# Connecting LLMs and tools

Every channel calls the same hosted API and gets the same 8 tools with the same
arguments and answers. Below:

- `BASE` = `https://<project-ref>.supabase.co/functions/v1/flpc`
- `TOKEN` = a **read** token from `select * from flpc.create_token('<name>', 365);` (see [SUPABASE.md](SUPABASE.md))

| Channel | Transport | Use for |
|---|---|---|
| Remote MCP `BASE/mcp` | Streamable HTTP | Claude (web, desktop, mobile), ChatGPT connectors, Claude Code, any MCP client that takes a URL |
| REST `BASE/api/*` + `BASE/openapi.json` | HTTPS JSON / text | ChatGPT Custom GPT Actions, scripts, n8n, spreadsheets, any LLM with HTTP tools |
| Local MCP (stdio) `mcp/server.mjs` or Docker image | stdin/stdout → REST | Claude Desktop config file, Docker MCP Toolkit, LM Studio, Cursor, local models |
| OpenClaw skill + `flpc` CLI | CLI → REST | OpenClaw, shell scripts, cron |

Nothing runs on your PC except the optional local MCP server or CLI. There is no
tunnel and no open port, and nothing stops when the PC sleeps.

Use one token per channel so you can revoke one without breaking the others. Any
URL that contains a token is a secret.

---

## Claude (claude.ai, Desktop, mobile)

Settings → **Connectors** → **Add custom connector**:

- Name: `Florida P&C`
- URL: `BASE/k/TOKEN/mcp`. The token sits in the URL because this form only takes a URL.

Then enable it in a chat from the tools menu. Connectors added on claude.ai also show
up in Claude Desktop and the mobile app.

## ChatGPT

**Connector (developer mode):** Settings → **Apps & Connectors** → Advanced → enable
**Developer mode** → **Create** → MCP server URL `BASE/k/TOKEN/mcp`, authentication **None**.

**Custom GPT (Actions):** Configure → **Actions** → **Import from URL** `BASE/openapi.json`
→ Authentication **API Key**, Auth type **Bearer**, paste `TOKEN`. Suggested
instructions: *"Call getCatalog first. For trends use timeseries; to explain a change
use comparePeriods (by company, then with companies=[...] and group_by='policy_type')."*

Menu names change from time to time. The URL and the auth method are what matter.

## Claude Code

```bash
claude mcp add --transport http florida-pc BASE/mcp --header "Authorization: Bearer TOKEN"
```

## Claude Desktop via config file / Docker MCP (local stdio)

For clients that start a local process instead of calling a URL. The container only
forwards calls to the hosted API.

```json
{
  "mcpServers": {
    "florida-pc": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "FLPC_URL", "-e", "FLPC_TOKEN", "ghcr.io/nithinmantena/pc-florida-mcp:latest"],
      "env": { "FLPC_URL": "BASE", "FLPC_TOKEN": "TOKEN" }
    }
  }
}
```

The image is published by CI on every push to `main`. The repo is private, so run
`docker login ghcr.io` once with a GitHub token that has `read:packages`, or build it
yourself: `docker build -f mcp/Dockerfile -t pc-florida-mcp .`.

**Without Docker** (Node 22+, from a clone): run `npm install`, then use
`"command": "node", "args": ["C:\\path\\to\\pc-florida\\mcp\\server.mjs"]` with the same `env`.

**Docker MCP Toolkit / gateway:** add a custom server with image
`ghcr.io/nithinmantena/pc-florida-mcp:latest` (stdio) and the two environment
variables above.

## OpenClaw

1. From a clone of the repo: `npm install -g .`. This puts the `flpc` command on the PATH.
2. `flpc config --url BASE --token TOKEN`, then `flpc health`.
3. Install the skill: copy `openclaw/skills/florida-pc/` into your OpenClaw skills
   folder (e.g. `~/.openclaw/skills/` or the workspace's `skills/`) and start a new
   OpenClaw session. The skill appears when `flpc` is on the PATH.

The skill tells the agent which `flpc` command answers which kind of question.
`flpc tools` lists every parameter. Examples:

```bash
flpc market_overview --line commercial
flpc rank --metric dpw --top_n 10 --exclude_companies Citizens
flpc compare_periods --metric tiv --companies "American Integrity" --group_by policy_type
flpc timeseries '{"metrics":["pif"],"group_by":"group","transform":"share","top_n":8}'
flpc run_sql --query "select period, sum(tiv) from facts group by 1 order by 1" --json
```

`FLPC_URL` / `FLPC_TOKEN` environment variables override the saved config. That is
useful if you prefer to keep secrets in OpenClaw's own config, under
`skills.entries.florida-pc.env`.

## Anything else (REST)

```bash
curl -s -X POST "BASE/api/rank?format=text" \
  -H "Authorization: Bearer TOKEN" -H "content-type: application/json" \
  -d '{"metric":"tiv","top_n":10,"exclude_companies":["Citizens"]}'
```

`GET` works too, with arguments as query parameters: `BASE/api/rank?metric=tiv&top_n=5&key=TOKEN`.
JSON responses are `{title, context, tables: [{title, columns, rows}], notes}`. The
[OpenAPI spec](../supabase/functions/_shared/flpc/openapi.ts) is served at `BASE/openapi.json`.

---

## Tool reference

The tools, their arguments and descriptions are defined once in
[`operations.json`](../supabase/functions/_shared/flpc/operations.json). Every channel
reads that file. Filters, periods, metrics and a worked drill-down are in
[API.md §4](API.md#4-tools).

Arguments are checked by name. A near-miss such as `company` for `companies` is
mapped, and anything unknown is rejected with the list of valid names. A filter is
never silently dropped, so a mistyped filter can't turn into a market-wide answer.
