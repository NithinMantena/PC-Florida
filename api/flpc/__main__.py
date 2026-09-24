"""CLI:  python -m flpc [serve|stdio|build]

  serve  HTTP server (MCP at /mcp + REST at /api)   [default]
  stdio  MCP over stdin/stdout (e.g. `docker run -i` from Claude Desktop)
  build  (re)build the SQLite store and exit
"""

from __future__ import annotations

import logging
import sys


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cmd = argv[0] if argv else "serve"
    # stdout is the protocol channel in stdio mode: log to stderr only
    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if cmd == "serve":
        import uvicorn

        from . import config
        uvicorn.run("flpc.server:app", host=config.HOST, port=config.PORT, proxy_headers=True,
                    forwarded_allow_ips="*")
    elif cmd == "stdio":
        from .mcp_server import get_store, mcp
        get_store()
        mcp.run("stdio")
    elif cmd == "build":
        from .store import Store
        s = Store(reload_interval=0)
        print(f"OK store at {s.db_path}: {s.periods[0][0]}..{s.periods[-1][0]}, {len(s.companies)} companies")
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
