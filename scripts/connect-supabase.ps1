<#
  One-time setup of the hosted Florida P&C API on this PC (replaces the manual
  steps in docs/SUPABASE.md and docs/INTEGRATIONS.md). Safe to re-run.

    powershell -ExecutionPolicy Bypass -File .\scripts\connect-supabase.ps1

  You are asked for one thing: a Supabase personal access token
  (https://supabase.com/dashboard/account/tokens). It is read hidden, never
  printed, and stored only as the SUPABASE_ACCESS_TOKEN GitHub secret.

  What it does:
    1. runs supabase/flpc.sql in the project (Management API = SQL Editor)
    2. creates API tokens: github-loader (load), chatbots (claude.ai/ChatGPT URL),
       local (OpenClaw, Docker MCP and Claude Code on this PC). Existing
       chatbots/local tokens are kept when this PC still has them.
    3. sets GitHub secrets SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN, FLPC_LOAD_TOKEN
    4. runs the `supabase` workflow (deploy function + load data) and checks /health
    5. this PC: flpc CLI + config, OpenClaw skill, Docker MCP profile server, Claude Code MCP
    6. prints the claude.ai / ChatGPT connector URL (and copies it to the clipboard)

  Tokens on this PC: %APPDATA%\flpc\config.json (local) and %APPDATA%\flpc\connector.json (chatbots).
#>
[CmdletBinding()]
param(
  [string]$ProjectRef = "ijwafrfvsojhouebgzkh",      # the reading list project
  [string]$Repo = "NithinMantena/PC-Florida",
  [string]$DockerProfile = "nithin_mantena",
  [string]$OpenClawSkills = "$HOME\.openclaw\workspace\skills",
  [switch]$RotateTokens,                             # replace the chatbots and local tokens too
  [switch]$SkipWorkflow,
  [switch]$SkipDocker,
  [switch]$SkipOpenClaw,
  [switch]$SkipClaudeCode
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Base = "https://$ProjectRef.supabase.co/functions/v1/flpc"
$ConfigDir = Join-Path $env:APPDATA "flpc"
$LocalConfig = Join-Path $ConfigDir "config.json"
$ConnectorConfig = Join-Path $ConfigDir "connector.json"
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Note($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# Run a native command with a secret on stdin (no trailing newline, never on the command line).
function Invoke-WithStdin([string]$Exe, [string]$Arguments, [string]$Stdin) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($Stdin); $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "$Exe $Arguments failed (exit $($p.ExitCode)): $err$out" }
}

# Windows PowerShell 5.1 turns redirected stderr of a native command into a terminating
# error under ErrorActionPreference=Stop; run such commands through this instead.
function Invoke-Quiet([scriptblock]$Block) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Block *> $null; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}

function Read-Json([string]$Path) {
  if (Test-Path $Path) { try { return Get-Content $Path -Raw | ConvertFrom-Json } catch { } }
  return $null
}
function Write-PrivateJson([string]$Path, $Object) {
  New-Item -ItemType Directory -Force $ConfigDir | Out-Null
  [System.IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json) + "`n", $Utf8)   # no BOM: Node reads it
}
function Sha256Hex([string]$s) {
  $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($Utf8.GetBytes($s))
  return -join ($h | ForEach-Object { $_.ToString("x2") })
}

# ---------------------------------------------------------------------------
Step "Checking prerequisites"
foreach ($c in "gh", "node", "npm") {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "'$c' is not installed or not on PATH." }
}
if ((Invoke-Quiet { gh auth status }) -ne 0) { throw "GitHub CLI is not logged in. Run: gh auth login" }
if ((Invoke-Quiet { gh api "repos/$Repo/contents/supabase/flpc.sql?ref=main" --silent }) -ne 0) { throw "main on github.com/$Repo does not have the Supabase code yet (supabase/flpc.sql)." }
Ok "GitHub: $Repo (main has the Supabase code)"

$pat = $env:SUPABASE_ACCESS_TOKEN
if (-not $pat) {
  Write-Host ""
  Write-Host "    Create a Supabase access token: https://supabase.com/dashboard/account/tokens"
  Write-Host "    (Generate new token -> name it 'pc-florida github' -> copy it)"
  $sec = Read-Host "    Paste the token (hidden)" -AsSecureString
  $pat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$pat = $pat.Trim()
if (-not $pat) { throw "No Supabase access token given." }
$Api = "https://api.supabase.com/v1/projects/$ProjectRef"
$Headers = @{ Authorization = "Bearer $pat" }

function Invoke-Sql([string]$Query) {
  $body = $Utf8.GetBytes((@{ query = $Query } | ConvertTo-Json -Compress))
  try {
    return Invoke-RestMethod -Method Post -Uri "$Api/database/query" -Headers $Headers `
      -ContentType "application/json; charset=utf-8" -Body $body
  } catch {
    $detail = $_.ErrorDetails.Message; if (-not $detail) { $detail = $_.Exception.Message }
    throw "SQL failed: $detail"
  }
}

try { $proj = Invoke-RestMethod -Uri $Api -Headers $Headers }
catch { throw "Supabase rejected the token or cannot see project $ProjectRef ($($_.Exception.Message))." }
Ok "Supabase project: $($proj.name) ($ProjectRef), status $($proj.status)"
if ($proj.status -ne "ACTIVE_HEALTHY") { Note "The project is not ACTIVE_HEALTHY. If it is paused, restore it in the dashboard first." }

# ---------------------------------------------------------------------------
Step "1. Database objects (supabase/flpc.sql)"
Invoke-Sql ([System.IO.File]::ReadAllText((Join-Path $RepoRoot "supabase\flpc.sql"), $Utf8)) | Out-Null
$owner = (Invoke-Sql "select tableowner from pg_tables where schemaname = 'flpc' and tablename = 'facts'").tableowner
Ok "schema flpc ready (tables owned by $owner)"

# ---------------------------------------------------------------------------
Step "2. API tokens"
function Test-TokenActive([string]$Token) {
  if (-not $Token) { return $false }
  $r = Invoke-Sql ("select count(*)::int as n from flpc.api_tokens where token_hash = '{0}' and revoked_at is null " +
                   "and (expires_at is null or expires_at > now() + interval '30 days')" -f (Sha256Hex $Token))
  return ($r.n -eq 1)
}
function New-FlpcToken([string]$Name, [int]$Days, [string]$Scopes) {
  Invoke-Sql "select flpc.revoke_token('$Name')" | Out-Null
  $r = Invoke-Sql "select token from flpc.create_token('$Name', $Days, '$Scopes')"
  if (-not $r.token) { throw "create_token('$Name') returned nothing" }
  return [string]$r.token
}

$loadToken = New-FlpcToken "github-loader" 3650 "{load}"
Ok "github-loader (load scope): new token, goes only to GitHub"

$cfg = Read-Json $LocalConfig
$localToken = if ($cfg) { [string]$cfg.token } else { "" }
if ($RotateTokens -or -not (Test-TokenActive $localToken)) {
  $localToken = New-FlpcToken "local" 365 "{read}"
  Ok "local (read): new token"
} else { Ok "local (read): kept the existing token" }
Write-PrivateJson $LocalConfig ([ordered]@{ url = $Base; token = $localToken })

$conn = Read-Json $ConnectorConfig
$chatToken = if ($conn) { [string]$conn.token } else { "" }
if ($RotateTokens -or -not (Test-TokenActive $chatToken)) {
  $chatToken = New-FlpcToken "chatbots" 365 "{read}"
  $chatRotated = $true
  Ok "chatbots (read): new token"
} else { $chatRotated = $false; Ok "chatbots (read): kept the existing token" }
Write-PrivateJson $ConnectorConfig ([ordered]@{ url = "$Base/k/$chatToken/mcp"; token = $chatToken })

# ---------------------------------------------------------------------------
Step "3. GitHub secrets"
Invoke-WithStdin "gh" "secret set SUPABASE_PROJECT_REF --repo $Repo" $ProjectRef
Invoke-WithStdin "gh" "secret set SUPABASE_ACCESS_TOKEN --repo $Repo" $pat
Invoke-WithStdin "gh" "secret set FLPC_LOAD_TOKEN --repo $Repo" $loadToken
Ok "SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN, FLPC_LOAD_TOKEN"
$pat = $null; $loadToken = $null

# ---------------------------------------------------------------------------
if (-not $SkipWorkflow) {
  Step "4. Deploy the function and load the data (GitHub Actions: supabase)"
  $since = (Get-Date).ToUniversalTime().AddSeconds(-5)
  gh workflow run supabase.yml --repo $Repo --ref main | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not start the supabase workflow" }
  $runId = $null
  for ($i = 0; $i -lt 30 -and -not $runId; $i++) {
    Start-Sleep -Seconds 3
    $runs = gh run list --repo $Repo --workflow supabase.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt | ConvertFrom-Json
    $runId = ($runs | Where-Object { ([datetime]$_.createdAt).ToUniversalTime() -ge $since } | Select-Object -First 1).databaseId
  }
  if (-not $runId) { throw "the workflow run did not appear; check https://github.com/$Repo/actions" }
  Ok "run https://github.com/$Repo/actions/runs/$runId (about 2 minutes)"
  gh run watch $runId --repo $Repo --exit-status --interval 10 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    gh run view $runId --repo $Repo --log-failed | Select-Object -Last 40
    throw "the supabase workflow failed (log above)"
  }
  Ok "deployed and loaded"
}

$health = Invoke-RestMethod "$Base/health"
Ok ("health: " + ($health | ConvertTo-Json -Compress))

# ---------------------------------------------------------------------------
if (-not $SkipOpenClaw) {
  Step "5a. flpc CLI and OpenClaw skill"
  Push-Location $RepoRoot
  try {
    npm install -g . --no-audit --no-fund --loglevel=error | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm install -g . failed" }
  } finally { Pop-Location }
  $dest = Join-Path $OpenClawSkills "florida-pc"
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $RepoRoot "openclaw\skills\florida-pc\*") $dest -Recurse -Force
  Ok "flpc on PATH, skill in $dest"
  $env:FLPC_URL = $null; $env:FLPC_TOKEN = $null
  $out = flpc rank --metric pif --top_n 3
  if ($LASTEXITCODE -ne 0) { throw "flpc test call failed: $out" }
  $out | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" }
}

if (-not $SkipDocker) {
  Step "5b. Docker MCP Toolkit (profile $DockerProfile)"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Note "docker not found; skipped" }
  else {
    if ((Invoke-Quiet { docker mcp profile show $DockerProfile }) -ne 0) { throw "Docker MCP profile '$DockerProfile' not found (is Docker Desktop running?)" }
    docker build -q -f (Join-Path $RepoRoot "mcp\Dockerfile") -t pc-florida-mcp:local $RepoRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker build of pc-florida-mcp:local failed" }
    Invoke-WithStdin "docker" "pass set docker/mcp/pc-florida.api_token --force" $localToken
    $catalogs = Join-Path $HOME ".docker\mcp\catalogs"
    New-Item -ItemType Directory -Force $catalogs | Out-Null
    $def = [ordered]@{
      name = "pc-florida"; title = "Florida P&C market data"; type = "server"; image = "pc-florida-mcp:local"
      description = "Florida residential P&C market data (FLOIR, 2022Q2 onward): rankings, market share, trends, what drove a change, carrier profiles, read-only SQL."
      env = @(@{ name = "FLPC_URL"; value = $Base })
      secrets = @(@{ name = "pc-florida.api_token"; env = "FLPC_TOKEN"; example = "flpc_read_token" })
      allowHosts = @("$ProjectRef.supabase.co:443")
    }
    [System.IO.File]::WriteAllText((Join-Path $catalogs "pc-florida.json"), ($def | ConvertTo-Json -Depth 5), $Utf8)
    # file:// resolves under ~/.docker/mcp/catalogs; add also updates an existing entry
    docker mcp profile server add $DockerProfile --server file://pc-florida.json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker mcp profile server add failed" }
    Ok "pc-florida added to profile $DockerProfile (restart connected MCP clients)"
  }
}

if (-not $SkipClaudeCode) {
  Step "5c. Claude Code (user scope)"
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Note "claude CLI not found; skipped" }
  else {
    Invoke-Quiet { claude mcp remove florida-pc --scope user } | Out-Null
    claude mcp add --scope user --transport http florida-pc "$Base/mcp" --header "Authorization: Bearer $localToken" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed" }
    Ok "florida-pc added (new Claude Code sessions)"
  }
}

# ---------------------------------------------------------------------------
Step "6. claude.ai / ChatGPT (manual: these apps only take a URL in their settings)"
$connectorUrl = "$Base/k/$chatToken/mcp"
try { Set-Clipboard -Value $connectorUrl; $copied = " (copied to the clipboard)" } catch { $copied = "" }
Write-Host "    Connector URL$copied. It contains a token, so treat it like a password:"
Write-Host "      $connectorUrl"
if ($chatRotated) { Note "This is a new token: replace the URL in any connector you added before." }
Write-Host "    claude.ai: Settings -> Connectors -> Add custom connector -> name 'Florida P&C', paste the URL."
Write-Host "      (Also appears in Claude Desktop and the mobile app.)"
Write-Host "    ChatGPT:  Settings -> Apps & Connectors -> Advanced -> Developer mode -> Create -> paste the URL, auth None."
Write-Host "    Saved in $ConnectorConfig if you need it again."
Write-Host ""
Write-Host "Done." -ForegroundColor Green
