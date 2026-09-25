"""Run every case in tests/parity_cases.json through the local (Python/SQLite)
engine and write the results as JSON. tests/engine.test.ts runs the same cases
through the hosted (TypeScript/Postgres) engine and compares.

    python api/tests/parity_dump.py data/parity.json
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "api"))
os.environ.setdefault("FLPC_INPUT_DIRS", REPO)
os.environ.setdefault("FLPC_DB", os.path.join(REPO, "data", "florida_pc.sqlite"))

from flpc import engine as E  # noqa: E402
from flpc.catalog import get_catalog  # noqa: E402
from flpc.fmt import UserError  # noqa: E402
from flpc.store import Store  # noqa: E402

TOOLS = {"get_catalog": lambda s, a: get_catalog(s), "find_companies": lambda s, a: E.find_companies(s, **a),
         "timeseries": lambda s, a: E.timeseries(s, **a), "compare_periods": lambda s, a: E.compare_periods(s, **a),
         "rank": lambda s, a: E.rank(s, **a), "company_profile": lambda s, a: E.company_profile(s, **a),
         "market_overview": lambda s, a: E.market_overview(s, **a)}


def main(out_path):
    store = Store(reload_interval=0)
    with open(os.path.join(REPO, "tests", "parity_cases.json")) as fh:
        cases = json.load(fh)
    results = []
    for name, args in cases:
        try:
            results.append({"ok": TOOLS[name](store, dict(args)).to_json()})
        except UserError as e:
            results.append({"error": str(e)})
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(results, fh, ensure_ascii=False)
    print(f"wrote {len(results)} results to {out_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "data", "parity.json"))
