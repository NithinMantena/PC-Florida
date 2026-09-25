"""Query engine and tool implementations (shared by MCP and REST).

All aggregation happens in SQLite (`SUM` over the tidy `facts` table grouped
by the requested dimensions and quarter); derived metrics are computed from
the summed base columns so ratios are always ratio-of-sums, never averages of
ratios. Suppressed source cells (a literal "." in the workbook) are NULL and
excluded from sums; responses note when a slice contains any.
"""

from __future__ import annotations

import difflib
import re
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass, field

from . import metrics as M
from .fmt import Response, Scale, UserError, num, pct
from .store import Store

MAX_METRICS = 8
MAX_TOP_N = 100

# --------------------------------------------------------------------------- #
# Input helpers
# --------------------------------------------------------------------------- #


def as_list(x, split: str | None = ","):
    """Accept a list or a delimited string; return a clean list or None."""
    if x is None:
        return None
    if isinstance(x, (list, tuple, set)):
        items = [str(i) for i in x if i is not None]
    else:
        items = re.split(split, str(x)) if split else [str(x)]
    items = [i.strip() for i in items if i and i.strip()]
    return items or None


def plabel(idx: int) -> str:
    return f"{idx // 4}Q{idx % 4 + 1}"


def parse_period(store: Store, s, default: str | None = None) -> int | None:
    """'latest', 'latest-4', '2026Q1', '2026-Q1', 'Q1 2026' -> period index."""
    if s is None or str(s).strip() == "":
        if default is None:
            return None
        s = default
    t = str(s).strip().lower().replace(" ", "")
    m = re.fullmatch(r"(?:latest|last|current)(?:-(\d+))?", t)
    if m:
        idx = store.latest_idx - int(m.group(1) or 0)
    else:
        m1 = re.fullmatch(r"(\d{4})[-_/]?q([1-4])", t)
        m2 = re.fullmatch(r"q([1-4])[-_/]?(\d{4})", t)
        if m1:
            idx = int(m1.group(1)) * 4 + int(m1.group(2)) - 1
        elif m2:
            idx = int(m2.group(2)) * 4 + int(m2.group(1)) - 1
        else:
            raise UserError(f"Bad period '{s}'. Use e.g. '2026Q1', 'latest' or 'latest-4'.")
    if idx not in store.idx_period:
        raise UserError(f"Period {plabel(idx)} is not in the data. Available: "
                        f"{store.periods[0][0]}..{store.periods[-1][0]} (latest = {store.periods[-1][0]}).")
    return idx


# --------------------------------------------------------------------------- #
# Entity resolution
# --------------------------------------------------------------------------- #

_STOP = {"insurance", "ins", "company", "co", "inc", "the", "of", "corp", "corporation", "incorporated",
         "llc", "and", "&", "group", "holdings"}


def _norm(s: str) -> str:
    return re.sub(r"[^A-Z0-9& ]+", " ", str(s).upper()).strip()


def _tokens(q: str) -> list[str]:
    toks = _norm(q).split()
    kept = [t for t in toks if t.lower() not in _STOP]
    return kept or toks


def _latest_size(store: Store) -> dict[str, float]:
    """naic -> TIV in the latest quarter (for ordering candidate lists)."""
    cache = getattr(store, "_size_cache", None)
    if cache and cache[0] == store.version:
        return cache[1]
    con = store.connect()
    try:
        sizes = {r[0]: r[1] or 0 for r in con.execute(
            "SELECT naic, SUM(tiv) FROM facts WHERE idx=? GROUP BY naic", (store.latest_idx,))}
    finally:
        con.close()
    store._size_cache = (store.version, sizes)
    return sizes


def match_companies(store: Store, q: str) -> list[str]:
    q = str(q).strip()
    if not q:
        return []
    if q in store.companies:
        return [q]
    if q.isdigit():
        return []
    nq = _norm(q)
    exact = [n for n, c in store.companies.items() if any(_norm(x) == nq for x in c.names)]
    if exact:
        return exact
    toks = _tokens(q)
    out = []
    for n, c in store.companies.items():
        hay = " | ".join(_norm(x) for x in c.names)
        if all(t in hay for t in toks):
            out.append(n)
    sizes = _latest_size(store)
    return sorted(out, key=lambda n: -sizes.get(n, 0))


def _describe_candidates(store: Store, naics: list[str], k: int = 8) -> str:
    return "; ".join(f"{store.companies[n].name} (NAIC {n}, last {store.companies[n].last})" for n in naics[:k])


def resolve_company(store: Store, q: str) -> str:
    hits = match_companies(store, q)
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        gids = {store.companies[n].group_id for n in hits}
        hint = ""
        if len(gids) == 1 and not store.groups[next(iter(gids))]["standalone"]:
            hint = f" They are all in group '{store.groups[next(iter(gids))]['name']}' — use groups=[...] to combine."
        raise UserError(f"'{q}' matches {len(hits)} companies: {_describe_candidates(store, hits)}. "
                        f"Pass a NAIC code or a more specific name.{hint}")
    names = {x: n for n, c in store.companies.items() for x in c.names}
    close = difflib.get_close_matches(_norm(q), [_norm(x) for x in names], n=5, cutoff=0.5)
    sugg = [x for x in names if _norm(x) in close]
    raise UserError(f"No company matches '{q}'." + (f" Did you mean: {'; '.join(sugg)}?" if sugg else
                                                   " Use find_companies to search."))


def resolve_group(store: Store, q: str) -> str:
    q = str(q).strip()
    if q in store.groups:
        return q
    nq = _norm(q)
    real = {g: d for g, d in store.groups.items() if not d["standalone"]}
    exact = [g for g, d in store.groups.items() if _norm(d["name"]) == nq]
    if len(exact) == 1:
        return exact[0]
    toks = _tokens(q)
    hits = [g for g, d in real.items() if all(t in _norm(d["name"]) for t in toks)]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise UserError(f"'{q}' matches several groups: {', '.join(real[g]['name'] for g in hits)}.")
    # a company name/NAIC resolves to that company's group
    comp = match_companies(store, q)
    if len(comp) == 1 or (comp and len({store.companies[n].group_id for n in comp}) == 1):
        return store.companies[comp[0]].group_id
    raise UserError(f"No carrier group matches '{q}'. Multi-company groups: "
                    f"{', '.join(sorted(d['name'] for d in real.values()))}. "
                    f"Any single company also works as its own group.")


LINE_ALIASES = {"commercial": "commercial", "commercial residential": "commercial", "c": "commercial",
                "comm": "commercial", "personal": "personal", "personal residential": "personal",
                "p": "personal", "pers": "personal"}


def resolve_line(line) -> str | None:
    if line is None:
        return None
    t = str(line).strip().lower().replace("_", " ")
    if t in ("", "all", "both", "any", "total"):
        return None
    if t not in LINE_ALIASES:
        raise UserError(f"Bad line '{line}'. Use 'commercial', 'personal' or omit for both.")
    return LINE_ALIASES[t]


def resolve_policy_types(store: Store, items) -> list[str] | None:
    items = as_list(items)
    if not items:
        return None
    out = []
    for it in items:
        t = it.strip().lower()
        hits = [p.id for p in store.policy_types.values()
                if t in (p.id, p.product, p.name.lower())]
        if not hits:
            hits = [p.id for p in store.policy_types.values() if p.id.startswith(t)]
        if not hits and t in ("wind", "wind_only", "wind only"):
            hits = [p.id for p in store.policy_types.values() if p.wind_only]
        if not hits:
            raise UserError(f"Unknown policy type '{it}'. Use an id ({', '.join(store.policy_types)}) "
                            f"or a product family ({', '.join(sorted({p.product for p in store.policy_types.values()}))}).")
        out += [h for h in hits if h not in out]
    return out


def resolve_bool(v) -> bool | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    t = str(v).strip().lower()
    if t in ("true", "yes", "y", "1", "only"):
        return True
    if t in ("false", "no", "n", "0", "exclude", "none"):
        return False
    if t in ("all", "any", "both"):
        return None
    raise UserError(f"Bad boolean '{v}'.")


# --------------------------------------------------------------------------- #
# Filters
# --------------------------------------------------------------------------- #


@dataclass
class Filters:
    naics: list | None = None
    group_ids: list | None = None
    exclude: list | None = None
    line: str | None = None
    pt_ids: list | None = None
    wind_only: bool | None = None
    labels: list = field(default_factory=list)

    def sql(self, a: str = "f"):
        where, args = [], []

        def inlist(col, vals, neg=False):
            where.append(f"{a}.{col} {'NOT ' if neg else ''}IN ({','.join('?' * len(vals))})")
            args.extend(vals)

        if self.naics:
            inlist("naic", self.naics)
        if self.group_ids:
            inlist("group_id", self.group_ids)
        if self.exclude:
            inlist("naic", self.exclude, neg=True)
        if self.line:
            where.append(f"{a}.line = ?")
            args.append(self.line)
        if self.pt_ids:
            inlist("pt_id", self.pt_ids)
        if self.wind_only is not None:
            where.append(f"{a}.wind_only = ?")
            args.append(int(self.wind_only))
        return where, args

    def describe(self) -> str:
        return "; ".join(self.labels) if self.labels else "all companies, all lines & policy types"


def _companies_arg(store, x) -> list[str] | None:
    """Company lists: a whole string that resolves wins; else split on , ; |."""
    if x is None:
        return None
    if isinstance(x, str):
        if len(match_companies(store, x)) == 1:
            return [x]
        return as_list(x, r"[;|,]")
    return as_list(x, None)


def make_filters(store: Store, companies=None, groups=None, exclude_companies=None, line=None,
                 policy_types=None, wind_only=None) -> Filters:
    f = Filters()
    comps = _companies_arg(store, companies)
    if comps:
        f.naics = []
        for c in comps:
            n = resolve_company(store, c)
            if n not in f.naics:
                f.naics.append(n)
        f.labels.append("companies=" + "; ".join(f"{store.companies[n].name} ({n})" for n in f.naics))
    grps = as_list(groups, r"[;|]") if isinstance(groups, str) else as_list(groups, None)
    if grps:
        f.group_ids = []
        for g in grps:
            gid = resolve_group(store, g)
            if gid not in f.group_ids:
                f.group_ids.append(gid)
        f.labels.append("groups=" + "; ".join(store.groups[g]["name"] for g in f.group_ids))
    exc = _companies_arg(store, exclude_companies)
    if exc:
        f.exclude = [resolve_company(store, c) for c in exc]
        f.labels.append("excluding " + "; ".join(store.companies[n].name for n in f.exclude))
    f.line = resolve_line(line)
    if f.line:
        f.labels.append(f"line={f.line}")
    f.pt_ids = resolve_policy_types(store, policy_types)
    if f.pt_ids:
        f.labels.append("policy_types=" + ",".join(f.pt_ids))
    f.wind_only = resolve_bool(wind_only)
    if f.wind_only is not None:
        f.labels.append("wind-only policy types" if f.wind_only else "excluding wind-only policy types")
    return f


# --------------------------------------------------------------------------- #
# Dimensions + aggregation
# --------------------------------------------------------------------------- #

DIMS = {"company": "f.naic", "group": "f.group_id", "line": "f.line", "policy_type": "f.pt_id",
        "product": "f.product", "wind_only": "f.wind_only"}
DIM_ALIASES = {"carrier": "company", "companies": "company", "naic": "company", "insurer": "company",
               "groups": "group", "parent": "group", "carrier_group": "group", "lines": "line",
               "policy_types": "policy_type", "policy": "policy_type", "pt": "policy_type", "type": "policy_type",
               "products": "product", "product_family": "product", "wind": "wind_only"}


def parse_dims(group_by, default=None) -> list[str]:
    items = as_list(group_by) if group_by is not None else as_list(default)
    out = []
    for it in items or []:
        t = it.strip().lower().replace(" ", "_")
        if t in ("none", "total", "all", ""):
            continue
        t = DIM_ALIASES.get(t, t)
        if t not in DIMS:
            raise UserError(f"Bad group_by '{it}'. Use: {', '.join(DIMS)} (max 2) or omit.")
        if t not in out:
            out.append(t)
    if len(out) > 2:
        raise UserError("group_by accepts at most 2 dimensions.")
    return out


def dim_columns(dims) -> list[str]:
    cols = []
    for d in dims:
        cols += ["naic", "company"] if d == "company" else [d]
    return cols


def dim_values(store: Store, dims, key) -> list:
    vals = []
    for d, v in zip(dims, key):
        if d == "company":
            c = store.companies.get(v)
            vals += [v, c.name if c else v]
        elif d == "group":
            vals.append(store.groups.get(v, {}).get("name", v))
        elif d == "wind_only":
            vals.append("wind-only" if v else "standard")
        else:
            vals.append(v)
    return vals


def _query(store: Store, sql: str, args) -> list:
    con = store.connect()
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def aggregate(store: Store, cols, dims, flt: Filters, idxs) -> dict:
    """{dim_key_tuple: {idx: {col: sum}}}. Unreported metric-periods -> None."""
    cols = list(cols)
    present = [c for c in cols if c in store.metric_cols]
    dcols = [DIMS[d] for d in dims]
    sel = dcols + ["f.idx"] + [f"SUM(f.{c})" for c in present]
    where, args = flt.sql()
    idxs = sorted(set(idxs))
    where.append(f"f.idx IN ({','.join('?' * len(idxs))})")
    args += idxs
    # ORDER BY keeps tie order deterministic (and identical in the hosted engine)
    sql = (f"SELECT {', '.join(sel)} FROM facts f WHERE {' AND '.join(where)} "
           f"GROUP BY {', '.join(dcols + ['f.idx'])} ORDER BY {', '.join(dcols + ['f.idx'])}")
    out: dict = defaultdict(dict)
    nd = len(dims)
    for r in _query(store, sql, args):
        key, idx = tuple(r[:nd]), r[nd]
        vals = {c: None for c in cols}
        for j, c in enumerate(present):
            vals[c] = r[nd + 1 + j] if store.available(c, idx) else None
        out[key][idx] = vals
    return out


def combine(sums_list, cols) -> dict:
    out = {c: None for c in cols}
    for s in sums_list:
        if not s:
            continue
        for c in cols:
            v = s.get(c)
            if v is not None:
                out[c] = (out[c] or 0) + v
    return out


def suppressed_note(store: Store, flt: Filters, cols, idxs) -> str | None:
    where, args = flt.sql("f")
    idxs = sorted(set(idxs))
    where.append(f"f.idx IN ({','.join('?' * len(idxs))})")
    args += idxs
    cols = [c for c in cols if c in store.metric_cols]
    if not cols:
        return None
    where.append(f"s.metric IN ({','.join('?' * len(cols))})")
    args += cols
    n = _query(store, "SELECT COUNT(*) FROM suppressed s JOIN facts f USING(period, naic, pt_id) WHERE "
               + " AND ".join(where), args)[0][0]
    if n:
        return (f"{n} source cell(s) in this slice were suppressed by FLOIR ('.') and are excluded "
                f"from sums (not treated as 0).")
    return None


def _check_available(store: Store, ms, idxs):
    for m in ms:
        for c in M.base_deps([m]):
            a = store.metric_avail.get(c)
            if not a:
                raise UserError(f"Metric '{m.id}' has no data in this dataset.")
            bad = [i for i in idxs if not (a[0] <= i <= a[1])]
            if bad and len(bad) == len(idxs):
                raise UserError(f"Metric '{m.id}' is only reported {plabel(a[0])}..{plabel(a[1])}; "
                                f"requested {', '.join(plabel(i) for i in idxs)}.")


def _s(v) -> str:
    """A number inside prose: 115.0 -> '115', None -> 'n/a' (same as the hosted engine)."""
    if v is None:
        return "n/a"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _growth(v, prev):
    """% change; undefined (None) when the base is <= 0 or the sign flips."""
    if v is None or prev is None or prev <= 0 or v < 0:
        return None
    return v / prev - 1


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #

TRANSFORMS = ("value", "qoq", "yoy", "diff", "share")


def timeseries(store: Store, metrics, group_by=None, start=None, end=None, transform="value",
               top_n=10, include_other=True, raw=False, **filters) -> Response:
    ms = [M.get(m) for m in (as_list(metrics) or [])]
    if not ms:
        raise UserError("metrics is required, e.g. ['tiv'].")
    if len(ms) > MAX_METRICS:
        raise UserError(f"At most {MAX_METRICS} metrics per call.")
    dims = parse_dims(group_by)
    flt = make_filters(store, **filters)
    i0 = parse_period(store, start, default=store.periods[0][0])
    i1 = parse_period(store, end, default="latest")
    if i0 > i1:
        i0, i1 = i1, i0
    transform = (transform or "value").lower()
    transform = {"pct_change": "qoq", "growth": "qoq", "change": "diff", "abs": "value",
                 "market_share": "share", "values": "value"}.get(transform, transform)
    if transform not in TRANSFORMS:
        raise UserError(f"Bad transform '{transform}'. Use one of {', '.join(TRANSFORMS)}.")
    if transform == "share" and any(not m.additive for m in ms):
        raise UserError("transform='share' only works for additive metrics (not ratios).")
    top_n = max(1, min(int(top_n or 10), MAX_TOP_N))
    look = {"yoy": 4, "qoq": 1, "diff": 1}.get(transform, 0)
    all_idx = [i for _, i in store.periods if i0 - look <= i <= i1]
    out_idx = [i for i in all_idx if i >= i0]
    _check_available(store, ms, out_idx)

    rank_m = next((m for m in ms if m.additive), M.BASE["tiv"])
    cols = M.base_deps(ms + [rank_m])
    data = aggregate(store, cols, dims, flt, all_idx)
    if not data:
        raise UserError(f"No data for this slice ({flt.describe()}).")
    total = {i: combine([v.get(i) for v in data.values()], cols) for i in all_idx}

    series = []                                        # (labels, {idx: sums})
    if dims:
        def rank_val(k):
            for i in reversed(out_idx):
                v = M.compute(rank_m, data[k].get(i) or {})
                if v is not None:
                    return abs(v)
            return 0
        keys = sorted(data, key=rank_val, reverse=True)
        top, rest = keys[:top_n], keys[top_n:]
        series = [(dim_values(store, dims, k), data[k]) for k in top]
        blank = [""] * (len(dim_columns(dims)) - 1)
        if rest and include_other:
            other = {i: combine([data[k].get(i) for k in rest], cols) for i in all_idx}
            series.append((blank + [f"All others ({len(rest)})"], other))
        if len(keys) > 1:
            series.append((blank + ["Total"], total))
    else:
        series = [([], total)]

    # compute values per (series, metric)
    rows_raw = []
    for labels, sums in series:
        for m in ms:
            vals = []
            for i in out_idx:
                v = M.compute(m, sums.get(i)) if sums.get(i) else None
                if transform == "diff":
                    p = M.compute(m, sums.get(i - 1)) if sums.get(i - 1) else None
                    v = None if v is None or p is None else v - p
                elif transform in ("qoq", "yoy"):
                    p = M.compute(m, sums.get(i - look)) if sums.get(i - look) else None
                    v = _growth(v, p)
                elif transform == "share":
                    t = M.compute(m, total.get(i))
                    v = None if v is None or not t else v / t
                vals.append(v)
            rows_raw.append((labels, m, vals))

    pct_out = transform in ("qoq", "yoy", "share")
    scales = {}
    for m in ms:
        allv = [v for _, mm, vals in rows_raw if mm is m for v in vals]
        scales[m.id] = Scale("pct", raw=raw) if pct_out else Scale(m.unit, allv, raw=raw)

    def mlabel(m):
        return f"{m.id} ({scales[m.id].label})"

    show_metric = len(ms) > 1 or not dims
    cols_out = dim_columns(dims) + (["metric"] if show_metric else []) + [plabel(i) for i in out_idx]
    rows = []
    for labels, m, vals in rows_raw:
        sc = scales[m.id]
        cells = [pct(v) for v in vals] if pct_out else [sc(v) for v in vals]
        rows.append(list(labels) + ([mlabel(m)] if show_metric else []) + cells)

    tname = {"value": "", "qoq": " — QoQ % change", "yoy": " — YoY % change", "diff": " — QoQ change",
             "share": " — % share of slice"}[transform]
    title = ", ".join(m.label for m in ms) + tname + (f" by {' × '.join(dims)}" if dims else "")
    r = Response(title)
    r.context.append(f"filters: {flt.describe()}")
    r.context.append(f"periods: {plabel(out_idx[0])}..{plabel(out_idx[-1])}"
                     + (f"; units: {', '.join(mlabel(m) for m in ms)}" if len(ms) == 1 else ""))
    if dims and len(data) > top_n:
        r.context.append(f"showing top {top_n} of {len(data)} by {rank_m.id} at {plabel(out_idx[-1])}")
    r.add(cols_out, rows)
    note = suppressed_note(store, flt, cols, out_idx)
    if note:
        r.notes.append(note)
    return r


def rank(store: Store, metric, period="latest", group_by="company", top_n=20, compare_to=None,
         extra_metrics=None, ascending=False, min_pif=None, raw=False, **filters) -> Response:
    m0 = M.get(metric)
    extras = [M.get(x) for x in (as_list(extra_metrics) or [])][:MAX_METRICS - 1]
    ms = [m0] + extras
    dims = parse_dims(group_by, default="company") or ["company"]
    flt = make_filters(store, **filters)
    i = parse_period(store, period, default="latest")
    ic = parse_period(store, compare_to)
    idxs = [i] + ([ic] if ic is not None else [])
    _check_available(store, [m0], [i])
    top_n = max(1, min(int(top_n or 20), MAX_TOP_N))
    if min_pif is None:
        min_pif = 0 if m0.additive else 100
    cols = M.base_deps(ms + [M.BASE["pif"]])
    data = aggregate(store, cols, dims, flt, idxs)
    if not data:
        raise UserError(f"No data for this slice ({flt.describe()}).")

    tot_i = combine([v.get(i) for v in data.values()], cols)
    tot_c = combine([v.get(ic) for v in data.values()], cols) if ic is not None else None
    T0 = M.compute(m0, tot_i)
    Tc = M.compute(m0, tot_c) if tot_c else None
    entries = []
    for k, per in data.items():
        s = per.get(i)
        if not s:
            continue
        v = M.compute(m0, s)
        if v is None or (m0.kind == "stock" and v == 0):
            continue
        if (s.get("pif") or 0) < min_pif:
            continue
        entries.append((k, v, s, per.get(ic) if ic is not None else None))
    entries.sort(key=lambda e: e[1], reverse=not ascending)
    shown = entries[:top_n]

    sc0 = Scale(m0.unit, [e[1] for e in shown] + [T0], raw=raw)
    scx = {m.id: Scale(m.unit, [M.compute(m, e[2]) for e in shown], raw=raw) for m in extras}
    cols_out = ["rank"] + dim_columns(dims) + [f"{m0.id} ({sc0.label})"]
    if m0.additive:
        cols_out.append("share_%")
    cols_out += [f"{m.id} ({scx[m.id].label})" for m in extras]
    if ic is not None:
        cols_out += [f"{m0.id}@{plabel(ic)}", "change", "change_%"] + (["share_chg_pp"] if m0.additive else [])
    rows = []
    for n, (k, v, s, sc_) in enumerate(shown, 1):
        row = [n] + dim_values(store, dims, k) + [sc0(v)]
        if m0.additive:
            row.append(pct(v / T0) if T0 else None)
        row += [scx[m.id](M.compute(m, s)) for m in extras]
        if ic is not None:
            pv = M.compute(m0, sc_) if sc_ else (0 if m0.additive else None)
            row += [sc0(pv), sc0(None if pv is None else v - pv), pct(_growth(v, pv))]
            if m0.additive:
                row.append(round(((v / T0) - ((pv or 0) / Tc if Tc else 0)) * 100, 2) if T0 else None)
        rows.append(row)
    blank = [""] * (len(dim_columns(dims)) - 1)
    trow = [""] + blank + [f"Total ({len(entries)} ranked)", sc0(T0)]
    if m0.additive:
        trow.append(100.0)
    trow += [scx[m.id](M.compute(m, tot_i)) for m in extras]
    if ic is not None:
        trow += [sc0(Tc), sc0(None if Tc is None or T0 is None else T0 - Tc), pct(_growth(T0, Tc))]
        if m0.additive:
            trow.append("")
    rows.append(trow)

    r = Response(f"{m0.label} ranking by {' × '.join(dims)} — {plabel(i)}")
    r.context.append(f"filters: {flt.describe()}")
    if not m0.additive:
        r.context.append(f"ratio metric: entities with < {min_pif} PIF excluded; total row = ratio of totals")
    r.add(cols_out, rows)
    note = suppressed_note(store, flt, cols, idxs)
    if note:
        r.notes.append(note)
    return r


def compare_periods(store: Store, metric, period_from="latest-1", period_to="latest", group_by="company",
                    top_n=15, min_pif=None, raw=False, **filters) -> Response:
    m = M.get(metric)
    dims = parse_dims(group_by, default="company") or ["company"]
    flt = make_filters(store, **filters)
    ia = parse_period(store, period_from, default="latest-1")
    ib = parse_period(store, period_to, default="latest")
    _check_available(store, [m], [ia])
    _check_available(store, [m], [ib])
    top_n = max(1, min(int(top_n or 15), MAX_TOP_N))
    if min_pif is None:
        min_pif = 0 if m.additive else 500
    cols = M.base_deps([m, M.BASE["pif"]])
    data = aggregate(store, cols, dims, flt, [ia, ib])
    if not data:
        raise UserError(f"No data for this slice ({flt.describe()}).")

    rows_raw = []
    for k, per in data.items():
        sa, sb = per.get(ia), per.get(ib)
        a = M.compute(m, sa) if sa else None
        b = M.compute(m, sb) if sb else None
        if m.additive:
            status = "new" if not a and b else ("exited" if a and not b else "")
            a, b = a or 0, b or 0
            if a == 0 and b == 0:
                continue
        else:
            if a is None or b is None:
                continue
            if min((sa or {}).get("pif") or 0, (sb or {}).get("pif") or 0) < min_pif:
                continue
            status = ""
        rows_raw.append((k, a, b, b - a, status))
    rows_raw.sort(key=lambda x: abs(x[3]), reverse=True)

    A = M.compute(m, combine([v.get(ia) for v in data.values()], cols))
    B = M.compute(m, combine([v.get(ib) for v in data.values()], cols))
    net = None if A is None or B is None else B - A
    shown, rest = rows_raw[:top_n], rows_raw[top_n:]
    sc = Scale(m.unit, [x for r_ in shown for x in r_[1:4]] + [A, B], raw=raw)
    la, lb = plabel(ia), plabel(ib)
    cols_out = dim_columns(dims) + [f"{la} ({sc.label})", f"{lb} ({sc.label})", "change", "change_%"]
    if m.additive:
        cols_out.append("share_of_net_change_%")
    rows = []
    for k, a, b, d, status in shown:
        labels = dim_values(store, dims, k)
        if status:
            labels[-1] = f"{labels[-1]} [{status}]"
        row = labels + [sc(a), sc(b), sc(d), pct(_growth(b, a))]
        if m.additive:
            row.append(pct(d / net) if net else None)
        rows.append(row)
    blank = [""] * (len(dim_columns(dims)) - 1)
    if rest and m.additive:
        ra, rb = sum(x[1] for x in rest), sum(x[2] for x in rest)
        rows.append(blank + [f"All others ({len(rest)})", sc(ra), sc(rb), sc(rb - ra), pct(_growth(rb, ra)),
                             pct((rb - ra) / net) if net else None])
    rows.append(blank + ["Total", sc(A), sc(B), sc(net), pct(_growth(B, A))] +
                ([100.0 if net else None] if m.additive else []))

    r = Response(f"{m.label}: {la} → {lb} change by {' × '.join(dims)}")
    r.context.append(f"filters: {flt.describe()}")
    r.context.append("sorted by absolute change" + ("" if m.additive else
                     f"; ratio metric — entities with < {min_pif} PIF excluded; total = ratio of totals"))
    r.add(cols_out, rows)
    if m.additive and net is not None:
        up = [x for x in rows_raw if x[3] > 0]
        dn = [x for x in rows_raw if x[3] < 0]
        gu, gd = sum(x[3] for x in up), sum(x[3] for x in dn)
        top_up = sum(x[3] for x in up[:3])
        r.notes.append(
            f"Net change {_s(sc(net))} {sc.label} ({_s(pct(_growth(B, A)))}%) = gross increases {_s(sc(gu))} "
            f"across {len(up)} + gross decreases {_s(sc(gd))} across {len(dn)}."
            + (f" Top 3 increases = {_s(pct(top_up / gu))}% of gross increases." if gu else ""))
    note = suppressed_note(store, flt, cols, [ia, ib])
    if note:
        r.notes.append(note)
    return r


PROFILE_METRICS = ["pif", "tiv", "dpw", "new_written", "received_in", "cancelled", "nonrenewed", "net_flow",
                   "claims_opened", "avg_premium", "avg_tiv", "premium_per_1k_tiv", "wind_share_tiv"]


def _resolve_entity(store: Store, company=None, group=None):
    """-> (Filters, dim, key, label, is_group)."""
    if group:
        gid = resolve_group(store, group)
        g = store.groups[gid]
        return Filters(group_ids=[gid]), "group", gid, g["name"], True
    if not company:
        raise UserError("Pass company (name or NAIC) or group.")
    try:
        n = resolve_company(store, company)
    except UserError as e:
        try:
            gid = resolve_group(store, company)
        except UserError:
            raise e
        g = store.groups[gid]
        return Filters(group_ids=[gid]), "group", gid, g["name"], True
    return Filters(naics=[n]), "company", n, store.companies[n].name, False


def company_profile(store: Store, company=None, group=None, period="latest", raw=False) -> Response:
    flt, dim, key, label, is_group = _resolve_entity(store, company, group)
    i = parse_period(store, period, default="latest")
    ms = [M.get(x) for x in PROFILE_METRICS]
    cols = M.base_deps(ms)
    trend_idx = [ix for _, ix in store.periods if i - 7 <= ix <= i]
    idxs = sorted(set(trend_idx + [ix for ix in (i - 1, i - 4) if ix in store.idx_period]))
    mine = aggregate(store, cols, [], flt, idxs).get((), {})
    if not mine.get(i):
        raise UserError(f"{label} has no data in {plabel(i)}.")
    state = aggregate(store, cols, [dim], Filters(), [i])

    r = Response(f"Profile: {label} — {plabel(i)}")
    if is_group:
        g = store.groups[key]
        r.context.append(f"group of {len(g['members'])} NAIC(s)" + (" (standalone)" if g["standalone"] else ""))
    else:
        c = store.companies[key]
        r.context.append(f"NAIC {c.naic}; group: {c.group_name if c.group_id != c.naic else 'standalone'}; "
                         f"reported {c.first}..{c.last}"
                         + (f"; names used: {' / '.join(c.names)}" if len(c.names) > 1 else ""))

    rows = []
    for m in ms:
        s = mine.get(i)
        v = M.compute(m, s)
        if v is None:
            continue
        q = M.compute(m, mine.get(i - 1)) if mine.get(i - 1) else None
        y = M.compute(m, mine.get(i - 4)) if mine.get(i - 4) else None
        sc = Scale(m.unit, [v], raw=raw)
        rank_, share = None, None
        if m.additive and m.kind == "stock":
            vals = sorted((M.compute(m, per.get(i)) or 0 for per in state.values()), reverse=True)
            rank_ = 1 + sum(1 for x in vals if x > v)
            tot = sum(vals)
            share = pct(v / tot) if tot else None
        rows.append([m.id, sc(v), sc.label, pct(_growth(v, q)), pct(_growth(v, y)), rank_, share])
    r.add(["metric", "value", "unit", "qoq_%", "yoy_%", f"state_rank_of_{len(state)}", "state_share_%"], rows,
          title="Key metrics")

    # by line and policy type
    by = aggregate(store, cols, ["policy_type"], flt, [i, i - 1] if i - 1 in store.idx_period else [i])
    lines = defaultdict(list)
    for (pt,), per in by.items():
        lines[store.policy_types[pt].line].append(per)
    tot_tiv = M.compute(M.BASE["tiv"], mine[i]) or 0
    st = Scale("usd", [M.compute(M.BASE["tiv"], mine[i])], raw=raw)
    sd = Scale("usd", [M.compute(M.BASE["dpw"], mine[i])], raw=raw)
    lrows = []
    for ln, pers in sorted(lines.items()):
        s = combine([p.get(i) for p in pers], cols)
        sp = combine([p.get(i - 1) for p in pers], cols)
        tv = s.get("tiv")
        lrows.append([ln, sc_int(s.get("pif")), st(tv), sd(s.get("dpw")),
                      pct(tv / tot_tiv) if tot_tiv and tv else None, pct(_growth(tv, sp.get("tiv")))])
    r.add(["line", "pif", f"tiv ({st.label})", f"dpw ({sd.label})", "tiv_share_%", "tiv_qoq_%"], lrows,
          title="By line")
    prow = []
    for (pt,), per in sorted(by.items(), key=lambda kv: -((kv[1].get(i) or {}).get("tiv") or 0)):
        s = per.get(i)
        if not s or not any(s.get(c) for c in ("pif", "tiv", "dpw")):
            continue
        sp = per.get(i - 1) or {}
        prow.append([pt, sc_int(s.get("pif")), st(s.get("tiv")), sd(s.get("dpw")),
                     pct(s.get("tiv") / tot_tiv) if tot_tiv and s.get("tiv") else None,
                     pct(_growth(s.get("tiv"), sp.get("tiv"))), pct(_growth(s.get("pif"), sp.get("pif")))])
    r.add(["policy_type", "pif", f"tiv ({st.label})", f"dpw ({sd.label})", "tiv_share_%", "tiv_qoq_%", "pif_qoq_%"],
          prow, title="By policy type")

    trows = []
    for ix in trend_idx:
        s = mine.get(ix)
        if not s:
            continue
        trows.append([plabel(ix), sc_int(s.get("pif")), st(s.get("tiv")), sd(s.get("dpw")),
                      sc_int(M.compute(M.DERIVED["net_flow"], s))])
    r.add(["period", "pif", f"tiv ({st.label})", f"dpw ({sd.label})", "net_flow"], trows, title="Trend")

    if is_group and len(store.groups[key]["members"]) > 1:
        mem = aggregate(store, cols, ["company"], flt, [i])
        mrows = sorted(([n, store.companies[n].name, sc_int(per[i].get("pif")), st(per[i].get("tiv")),
                         sd(per[i].get("dpw"))] for (n,), per in mem.items() if per.get(i)),
                       key=lambda x: -(x[2] or 0))
        r.add(["naic", "company", "pif", f"tiv ({st.label})", f"dpw ({sd.label})"], mrows, title="Members")
    note = suppressed_note(store, flt, cols, [i])
    if note:
        r.notes.append(note)
    return r


def sc_int(v):
    return None if v is None else int(round(v))


OVERVIEW_METRICS = ["pif", "tiv", "dpw", "new_written", "received_in", "cancelled", "nonrenewed", "net_flow",
                    "claims_opened", "avg_premium", "premium_per_1k_tiv"]


def market_overview(store: Store, period="latest", top_n=5, raw=False, **filters) -> Response:
    flt = make_filters(store, **filters)
    i = parse_period(store, period, default="latest")
    top_n = max(1, min(int(top_n or 5), 25))
    ms = [M.get(x) for x in OVERVIEW_METRICS]
    cols = M.base_deps(ms)
    idxs = [ix for ix in (i, i - 1, i - 4) if ix in store.idx_period]
    by_line = aggregate(store, cols, ["line"], flt, idxs)
    if not by_line:
        raise UserError(f"No data for this slice ({flt.describe()}).")
    tot = {ix: combine([v.get(ix) for v in by_line.values()], cols) for ix in idxs}
    split = not flt.line and len(by_line) > 1

    r = Response(f"Market overview — {plabel(i)}")
    r.context.append(f"filters: {flt.describe()}")
    rows = []
    for m in ms:
        v = M.compute(m, tot[i])
        if v is None:
            continue
        sc = Scale(m.unit, [v], raw=raw)
        row = [m.id, sc(v), sc.label,
               pct(_growth(v, M.compute(m, tot[i - 1]))) if i - 1 in tot else None,
               pct(_growth(v, M.compute(m, tot[i - 4]))) if i - 4 in tot else None]
        if split:
            for ln in ("commercial", "personal"):
                per = by_line.get((ln,), {})
                lv = M.compute(m, per.get(i)) if per.get(i) else None
                row += [sc(lv), pct(_growth(lv, M.compute(m, per.get(i - 1)))) if per.get(i - 1) else None]
        rows.append(row)
    r.add(["metric", "value", "unit", "qoq_%", "yoy_%"] +
          (["commercial", "comm_qoq_%", "personal", "pers_qoq_%"] if split else []), rows, title="Totals")

    if i - 1 in store.idx_period:
        mv_cols = M.base_deps([M.BASE["tiv"], M.BASE["pif"]])
        byc = aggregate(store, mv_cols, ["company"], flt, [i, i - 1])
        for mid in ("tiv", "pif"):
            m = M.BASE[mid]
            ch = []
            for (n,), per in byc.items():
                a = (per.get(i - 1) or {}).get(mid) or 0
                b = (per.get(i) or {}).get(mid) or 0
                if a or b:
                    ch.append((n, a, b, b - a))
            ch.sort(key=lambda x: x[3], reverse=True)
            picks = ch[:top_n] + [x for x in ch[-top_n:][::-1] if x[3] < 0 and x not in ch[:top_n]]
            sc = Scale(m.unit, [x for p in picks for x in p[1:]], raw=raw)
            r.add(["naic", "company", f"{plabel(i - 1)} ({sc.label})", f"{plabel(i)} ({sc.label})", "change",
                   "change_%"],
                  [[n, store.companies[n].name, sc(a), sc(b), sc(d), pct(_growth(b, a))] for n, a, b, d in picks],
                  title=f"Top {mid} movers QoQ (gainers then decliners)")

    byc = aggregate(store, ["tiv", "pif", "dpw"], ["company"], flt, [i])
    lead = sorted(((n, per[i]) for (n,), per in byc.items() if per.get(i)),
                  key=lambda x: -(x[1].get("tiv") or 0))[:10]
    T = tot[i].get("tiv") or 0
    st = Scale("usd", [x[1].get("tiv") for x in lead], raw=raw)
    sd = Scale("usd", [x[1].get("dpw") for x in lead], raw=raw)
    r.add(["naic", "company", f"tiv ({st.label})", "tiv_share_%", "pif", f"dpw ({sd.label})"],
          [[n, store.companies[n].name, st(s.get("tiv")), pct(s.get("tiv") / T) if T and s.get("tiv") else None,
            sc_int(s.get("pif")), sd(s.get("dpw"))] for n, s in lead], title="Largest 10 by TIV")
    return r


def find_companies(store: Store, query, limit=10, period="latest") -> Response:
    q = str(query or "").strip()
    if not q:
        raise UserError("query is required (company name fragment, group name or NAIC).")
    limit = max(1, min(int(limit or 10), 50))
    i = parse_period(store, period, default="latest")
    hits = match_companies(store, q)
    if not hits and not q.isdigit():
        toks = _tokens(q)
        hits = [n for n, c in store.companies.items()
                if any(t in " ".join(_norm(x) for x in c.names) for t in toks)]
    grp_hits = [g for g, d in store.groups.items() if not d["standalone"]
                and all(t in _norm(d["name"]) for t in _tokens(q))]
    for g in grp_hits:
        hits += [n for n in store.groups[g]["members"] if n not in hits]
    size = aggregate(store, ["pif", "tiv"], ["company"], Filters(), [i])
    ranks = {n: k for k, (n,) in enumerate(sorted(size, key=lambda k: -((size[k].get(i) or {}).get("pif") or 0)), 1)}
    hits = sorted(dict.fromkeys(hits), key=lambda n: -(((size.get((n,)) or {}).get(i) or {}).get("tiv") or 0))[:limit]
    if not hits:
        raise UserError(f"No companies match '{q}'.")
    st = Scale("usd", [((size.get((n,)) or {}).get(i) or {}).get("tiv") for n in hits])
    rows = []
    for n in hits:
        c = store.companies[n]
        s = (size.get((n,)) or {}).get(i) or {}
        rows.append([n, c.name, c.group_name if c.group_id != n else "", " / ".join(x for x in c.names if x != c.name),
                     c.first, c.last, sc_int(s.get("pif")), st(s.get("tiv")), ranks.get(n)])
    r = Response(f"Companies matching '{q}'")
    r.context.append(f"size columns as of {plabel(i)}; use the NAIC or exact name in other tools")
    r.add(["naic", "name", "group", "other_names", "first", "last", "pif", f"tiv ({st.label})", "pif_rank"], rows)
    if grp_hits:
        r.notes.append("Matching groups (use groups=[...]): " +
                       "; ".join(f"{store.groups[g]['name']} ({len(store.groups[g]['members'])} NAICs)" for g in grp_hits))
    return r


# --------------------------------------------------------------------------- #
# SQL escape hatch
# --------------------------------------------------------------------------- #

SQL_SCHEMA = """facts(period TEXT '2026Q1', idx INT (year*4+q-1), naic TEXT, group_id TEXT, pt_id TEXT, line TEXT 'commercial'|'personal', product TEXT, wind_only INT, <metric columns REAL: pif, pif_incl_wind, pif_excl_wind, tiv, tiv_incl_wind, tiv_excl_wind, dpw, dpw_incl_wind, dpw_excl_wind, new_written, received_in, transferred_out, cancelled, cancelled_hurricane, nonrenewed, nonrenewed_hurricane, claims_*, lawsuits_*>)  -- one row per quarter x company x policy type; NULL = not reported/suppressed
companies(naic, name, names 'A | B', group_id, group_name, first_period, last_period)
groups(group_id, group_name, standalone, members 'naic,naic')
policy_types(pt_id, policy_type, line, product, wind_only)
periods(period, idx, year, quarter, period_end, pulled_at, source_file)
metrics(metric, first_period, last_period, n_periods)
suppressed(period, naic, pt_id, metric)
published_totals(file_type 'A'|'B', period, metric, value)  -- FLOIR 'Total' row
summary_a(period, naic, company, a_pif, a_pif_commercial, a_pif_personal, a_dpw, a_dpw_commercial, a_dpw_personal)"""

_ALLOWED_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}


def run_sql(store: Store, query: str, limit: int = 200) -> Response:
    q = (query or "").strip().rstrip(";")
    if not q:
        raise UserError("query is required.")
    if not re.match(r"(?is)^\s*(select|with)\b", q):
        raise UserError("Only SELECT / WITH queries are allowed.")
    limit = max(1, min(int(limit or 200), 1000))
    con = store.connect()
    deadline = time.time() + 5

    def auth(action, *_):
        return sqlite3.SQLITE_OK if action in _ALLOWED_ACTIONS else sqlite3.SQLITE_DENY

    con.set_authorizer(auth)
    con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10000)
    try:
        cur = con.execute(q)
        rows = cur.fetchmany(limit + 1)
        cols = [d[0] for d in cur.description or []]
    except sqlite3.Error as e:
        raise UserError(f"SQL error: {e}. Schema:\n{SQL_SCHEMA}")
    finally:
        con.close()
    r = Response("SQL result")
    r.add(cols, [[num(v) if isinstance(v, float) else v for v in row] for row in rows[:limit]])
    if len(rows) > limit:
        r.notes.append(f"truncated to {limit} rows")
    return r
