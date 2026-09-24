"""Runtime settings (environment variables)."""

from __future__ import annotations

import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _dirs(val: str | None) -> list[str]:
    if not val:
        return [REPO_ROOT]
    parts = [p.strip() for chunk in val.split(os.pathsep) for p in chunk.split(",")]
    return [p for p in parts if p]


# Folders scanned for FLOIR .xlsx workbooks (newest pull-timestamp wins per
# quarter across all of them). In Docker: the bundled history + a /data mount.
INPUT_DIRS = _dirs(os.environ.get("FLPC_INPUT_DIRS"))

# Where the normalized SQLite store is (re)built.
DB_PATH = os.environ.get("FLPC_DB", os.path.join(REPO_ROOT, "data", "florida_pc.sqlite"))


def groups_path() -> str:
    """carrier_groups.csv: an override dropped in any input folder wins."""
    explicit = os.environ.get("FLPC_GROUPS")
    if explicit:
        return explicit
    for d in reversed(INPUT_DIRS):
        p = os.path.join(d, "carrier_groups.csv")
        if os.path.exists(p):
            return p
    return os.path.join(REPO_ROOT, "config", "carrier_groups.csv")


# Seconds between checks of the input folders for new/changed workbooks.
RELOAD_INTERVAL = float(os.environ.get("FLPC_RELOAD_INTERVAL", "60"))

# Optional shared secret. When set, every request (except /health) must carry
# it as `Authorization: Bearer <key>`, `X-API-Key: <key>`, `?key=<key>`, or a
# `/k/<key>/...` path prefix (for MCP clients that only accept a URL).
API_KEY = os.environ.get("FLPC_API_KEY") or os.environ.get("API_KEY") or ""

# Public base URL (e.g. https://pc-florida.tailnet.ts.net) advertised in the
# OpenAPI spec so ChatGPT Custom GPT Actions know where to call.
PUBLIC_URL = os.environ.get("FLPC_PUBLIC_URL", "").rstrip("/")

HOST = os.environ.get("FLPC_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLPC_PORT", "8000"))
