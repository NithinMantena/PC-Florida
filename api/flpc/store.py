"""SQLite store: (re)build from the FLOIR workbooks and cached dimensions.

The server watches its input folders; when a workbook (or the carrier-group
CSV) is added or changed it rebuilds the store with `etl/ingest.py` and swaps
it in atomically. Drop a new quarter's .xlsx in the folder — no restart.
"""

from __future__ import annotations

import glob
import importlib.util
import json
import logging
import os
import sqlite3
import threading
import time
from dataclasses import dataclass

from . import config

log = logging.getLogger("flpc.store")


def _load_ingest():
    path = os.path.join(config.REPO_ROOT, "etl", "ingest.py")
    spec = importlib.util.spec_from_file_location("flpc_ingest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@dataclass
class Company:
    naic: str
    name: str
    names: list[str]
    group_id: str
    group_name: str
    first: str
    last: str


@dataclass
class PolicyType:
    id: str
    name: str
    line: str
    product: str
    wind_only: bool


class Store:
    def __init__(self, input_dirs=None, db_path=None, groups_path=None, reload_interval=None):
        self.input_dirs = input_dirs or config.INPUT_DIRS
        self.db_path = db_path or config.DB_PATH
        self.groups_path = groups_path or config.groups_path()
        self.reload_interval = config.RELOAD_INTERVAL if reload_interval is None else reload_interval
        self._lock = threading.Lock()
        self._last_check = 0.0
        self._sig = None
        self.version = 0
        self.last_error: str | None = None
        self.ensure(force=True)

    # ------------------------------------------------------------------ #
    # build / reload
    # ------------------------------------------------------------------ #
    def _signature(self):
        items = []
        for d in self.input_dirs:
            for p in sorted(glob.glob(os.path.join(d, "*.xlsx"))):
                st = os.stat(p)
                items.append((os.path.basename(p), int(st.st_mtime), st.st_size))
        for p in (self.groups_path, os.path.join(config.REPO_ROOT, "etl", "ingest.py")):
            if os.path.exists(p):
                st = os.stat(p)
                items.append((p, int(st.st_mtime), st.st_size))
        return json.dumps(items)

    def ensure(self, force: bool = False):
        """Rebuild the store if inputs changed (checked at most every N s)."""
        now = time.time()
        if not force and now - self._last_check < self.reload_interval:
            return
        with self._lock:
            if not force and now - self._last_check < self.reload_interval:
                return
            self._last_check = now
            sig = self._signature()
            sig_file = self.db_path + ".sig"
            if sig == self._sig and os.path.exists(self.db_path):
                return
            stored = open(sig_file).read() if os.path.exists(sig_file) else None
            has_xlsx = '.xlsx"' in sig
            if os.path.exists(self.db_path) and (stored == sig or not has_xlsx):
                pass                                   # up to date (or nothing to build from)
            else:
                try:
                    log.info("building store from %s", self.input_dirs)
                    ingest = _load_ingest()
                    data = ingest.build(self.input_dirs, self.groups_path)
                    ingest.write_sqlite(data, self.db_path)
                    with open(sig_file, "w") as fh:
                        fh.write(sig)
                    self.last_error = None
                    log.info("store built: %d periods, %d rows", len(data["period_order"]), len(data["facts_b"]))
                except BaseException as e:            # keep serving the previous store
                    self.last_error = f"rebuild failed: {e}"
                    log.exception("store rebuild failed")
                    if not os.path.exists(self.db_path):
                        raise RuntimeError(self.last_error) from e
            self._sig = sig
            self._load_dims()

    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False)
        con.row_factory = sqlite3.Row
        return con

    # ------------------------------------------------------------------ #
    # cached dimensions
    # ------------------------------------------------------------------ #
    def _load_dims(self):
        con = self.connect()
        try:
            q = lambda sql: con.execute(sql).fetchall()
            self.meta = {r["key"]: r["value"] for r in q("SELECT * FROM meta")}
            self.periods = [(r["period"], r["idx"]) for r in q("SELECT period, idx FROM periods ORDER BY idx")]
            self.period_idx = dict(self.periods)
            self.idx_period = {i: p for p, i in self.periods}
            self.metric_cols = [r[1] for r in q("PRAGMA table_info(facts)")][8:]
            self.metric_avail = {r["metric"]: (self.period_idx[r["first_period"]], self.period_idx[r["last_period"]])
                                 for r in q("SELECT * FROM metrics")}
            self.companies = {
                r["naic"]: Company(r["naic"], r["name"], r["names"].split(" | ") if r["names"] else [],
                                   r["group_id"], r["group_name"], r["first_period"], r["last_period"])
                for r in q("SELECT * FROM companies")}
            self.groups = {r["group_id"]: {"name": r["group_name"], "standalone": bool(r["standalone"]),
                                           "members": r["members"].split(",")}
                           for r in q("SELECT * FROM groups")}
            self.policy_types = {r["pt_id"]: PolicyType(r["pt_id"], r["policy_type"], r["line"], r["product"],
                                                        bool(r["wind_only"]))
                                 for r in q("SELECT * FROM policy_types ORDER BY pt_id")}
        finally:
            con.close()
        self.version += 1

    @property
    def latest_idx(self) -> int:
        return self.periods[-1][1]

    def available(self, metric: str, idx: int) -> bool:
        a = self.metric_avail.get(metric)
        return bool(a) and a[0] <= idx <= a[1]
