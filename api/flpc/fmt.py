"""Response container + compact number formatting.

Every tool returns a `Response`: a title, a few context lines (filters, units),
one or more small tables and optional notes. It renders either as compact
CSV-style text (MCP — cheapest for an LLM to read) or as JSON (REST).
"""

from __future__ import annotations

import csv
import io
import math
from dataclasses import dataclass, field


class UserError(ValueError):
    """Bad input from the caller; the message is meant to be shown to the LLM."""


@dataclass
class Table:
    columns: list[str]
    rows: list[list]
    title: str | None = None


@dataclass
class Response:
    title: str
    context: list[str] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, columns, rows, title=None) -> Table:
        t = Table(list(columns), [list(r) for r in rows], title)
        self.tables.append(t)
        return t

    def to_text(self) -> str:
        out = io.StringIO()
        out.write(f"## {self.title}\n")
        for c in self.context:
            out.write(c + "\n")
        w = csv.writer(out, lineterminator="\n")
        for t in self.tables:
            if t.title:
                out.write(f"\n# {t.title}\n")
            elif len(self.tables) > 1 or self.context:
                out.write("\n")
            w.writerow(t.columns)
            for r in t.rows:
                w.writerow(["" if v is None else v for v in r])
        if self.notes:
            out.write("\nNotes:\n")
            for n in self.notes:
                out.write(f"- {n}\n")
        return out.getvalue().rstrip() + "\n"

    def to_json(self) -> dict:
        return {
            "title": self.title,
            "context": self.context,
            "tables": [{"title": t.title, "columns": t.columns, "rows": t.rows} for t in self.tables],
            "notes": self.notes,
        }


# --------------------------------------------------------------------------- #
# Numbers
# --------------------------------------------------------------------------- #

def num(v, sig: int = 4):
    """Round for display: >=1000 -> int, else `sig` significant figures."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, int):
        return v
    a = abs(v)
    if a >= 1000 or v == int(v):
        return int(round(v))
    digits = sig - 1 - int(math.floor(math.log10(a)))
    r = round(v, max(digits, 0))
    return 0 if r == 0 else r


def pct(v, decimals: int = 1):
    """Fraction -> percent number (0.1234 -> 12.3)."""
    if v is None:
        return None
    r = round(v * 100, decimals)
    return 0.0 if r == 0 else r


USD_SCALES = [(1e9, "$B"), (1e6, "$M"), (1e3, "$K")]


class Scale:
    """Display scaling for one metric/unit across a whole table."""

    def __init__(self, unit: str, values=(), raw: bool = False):
        self.unit = unit
        self.div, self.label = 1.0, {"usd": "$", "usd_each": "$", "pct": "%",
                                     "count": "count", "rate": "per 1k"}.get(unit, unit)
        if unit == "usd" and not raw:
            vals = [abs(v) for v in values if v is not None]
            m = max(vals) if vals else 0
            for d, lab in USD_SCALES:
                if m >= d:
                    self.div, self.label = d, lab
                    break

    def __call__(self, v):
        if v is None:
            return None
        if self.unit == "pct":
            return pct(v, 2)
        if self.unit == "count":
            return int(round(v)) if abs(v) >= 1 or v == 0 else num(v)
        return num(v / self.div)
