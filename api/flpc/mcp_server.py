"""MCP server exposing the Florida P&C tools.

Tool results are compact CSV-style text (cheapest for an LLM to read). Tool
descriptions are kept short on purpose — they are sent with every request —
and `get_catalog` carries the full reference.
"""

from __future__ import annotations

import threading
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import Field

from . import __version__
from . import engine as E
from .catalog import get_catalog as _catalog
from .fmt import UserError
from .store import Store

INSTRUCTIONS = """Florida residential P&C insurance market data (FLOIR QUASR / Quarterly-MIR), quarterly by company (NAIC) x policy type, 2022Q2 onward: policies in force, TIV/exposure, premium, new/cancelled/nonrenewed/takeout flows, claims, lawsuits.
Start with get_catalog (metrics, policy types, periods). Drill down: timeseries -> compare_periods (who drove a change) -> compare_periods with companies=[...] and group_by='policy_type' (what drove it). Use rank for league tables/market share, company_profile for a one-call carrier summary, market_overview for a quarter headline. Results are CSV; $ columns are scaled ($K/$M/$B shown in headers)."""

_store: Store | None = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = Store()
    _store.ensure()
    return _store


def _run(fn, *args, **kw) -> str:
    try:
        return fn(get_store(), *args, **kw).to_text()
    except UserError as e:
        raise ToolError(str(e)) from e


RO = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)

# ---- shared parameter types ------------------------------------------------ #
StrList = list[str] | str | None
Companies = Annotated[StrList, Field(description="Company names or NAIC codes (fuzzy; e.g. ['American Integrity','10064'])")]
Groups = Annotated[StrList, Field(description="Carrier groups (e.g. ['Universal Insurance Holdings'])")]
Exclude = Annotated[StrList, Field(description="Companies to exclude (e.g. ['Citizens'] for private market)")]
Line = Annotated[str | None, Field(description="'commercial' | 'personal' | omit for both")]
PolicyTypes = Annotated[StrList, Field(description="Policy type ids, product families or id prefixes (see get_catalog), e.g. ['cmp'], ['c_condo_assoc_wind'], ['p_ho']")]
WindOnly = Annotated[bool | None, Field(description="true = only wind-only policy types; false = exclude them")]
GroupBy = Annotated[StrList, Field(description="Split by: company | group | line | policy_type | product | wind_only (max 2)")]
Period = Annotated[str | None, Field(description="'2026Q1', 'latest', 'latest-1', 'latest-4'")]
Raw = Annotated[bool, Field(description="true = unscaled raw dollars")]


def build_server() -> MCPServer:
    mcp = MCPServer("florida-pc", instructions=INSTRUCTIONS, version=__version__)

    @mcp.tool(annotations=RO, structured_output=False)
    def get_catalog() -> str:
        """Everything available: periods, metric ids/definitions (base + derived), policy type ids, carrier groups, filter/period syntax, caveats and the recommended drill-down workflow. Call first."""
        return _run(_catalog)

    @mcp.tool(annotations=RO, structured_output=False)
    def find_companies(
        query: Annotated[str, Field(description="Name fragment, group name or NAIC")],
        limit: int = 10,
    ) -> str:
        """Search companies by (current or former) name, group or NAIC. Returns NAIC, group, name history, active range, latest PIF/TIV and rank."""
        return _run(E.find_companies, query, limit=limit)

    @mcp.tool(annotations=RO, structured_output=False)
    def timeseries(
        metrics: Annotated[list[str] | str, Field(description="Metric id(s), e.g. ['tiv'] or ['pif','avg_premium']")],
        group_by: GroupBy = None,
        start: Period = None,
        end: Period = None,
        transform: Annotated[str, Field(description="value | qoq (% vs prior qtr) | yoy (% vs year ago) | diff (abs QoQ change) | share (% of slice total)")] = "value",
        top_n: Annotated[int, Field(description="When grouped: keep the N largest series (+ 'All others' and 'Total' rows)")] = 10,
        companies: Companies = None,
        groups: Groups = None,
        exclude_companies: Exclude = None,
        line: Line = None,
        policy_types: PolicyTypes = None,
        wind_only: WindOnly = None,
        raw: Raw = False,
    ) -> str:
        """Metric(s) over quarters for any slice, optionally split by a dimension. Use to spot trends and the quarter where something changed. Default range: all quarters."""
        return _run(E.timeseries, metrics, group_by=group_by, start=start, end=end, transform=transform,
                    top_n=top_n, companies=companies, groups=groups, exclude_companies=exclude_companies,
                    line=line, policy_types=policy_types, wind_only=wind_only, raw=raw)

    @mcp.tool(annotations=RO, structured_output=False)
    def compare_periods(
        metric: Annotated[str, Field(description="Metric id, e.g. 'tiv'")],
        period_from: Period = "latest-1",
        period_to: Period = "latest",
        group_by: GroupBy = "company",
        top_n: int = 15,
        companies: Companies = None,
        groups: Groups = None,
        exclude_companies: Exclude = None,
        line: Line = None,
        policy_types: PolicyTypes = None,
        wind_only: WindOnly = None,
        raw: Raw = False,
    ) -> str:
        """Attribute the change in a metric between two quarters: rows sorted by absolute change with % change and share of the net change, plus 'All others' and 'Total'. Answers 'who/what drove it'. Use group_by='policy_type' with companies=[...] to see which lines drove one carrier's change."""
        return _run(E.compare_periods, metric, period_from=period_from, period_to=period_to, group_by=group_by,
                    top_n=top_n, companies=companies, groups=groups, exclude_companies=exclude_companies,
                    line=line, policy_types=policy_types, wind_only=wind_only, raw=raw)

    @mcp.tool(annotations=RO, structured_output=False)
    def rank(
        metric: Annotated[str, Field(description="Metric to rank by, e.g. 'dpw'")],
        period: Period = "latest",
        group_by: GroupBy = "company",
        top_n: int = 20,
        compare_to: Annotated[str | None, Field(description="Optional earlier period for change / share-change columns")] = None,
        extra_metrics: Annotated[StrList, Field(description="Extra metric columns, e.g. ['pif','avg_premium']")] = None,
        ascending: bool = False,
        companies: Companies = None,
        groups: Groups = None,
        exclude_companies: Exclude = None,
        line: Line = None,
        policy_types: PolicyTypes = None,
        wind_only: WindOnly = None,
        raw: Raw = False,
    ) -> str:
        """League table for one quarter with market share of the slice (and optional change vs compare_to). Ratio metrics exclude entities under 100 PIF."""
        return _run(E.rank, metric, period=period, group_by=group_by, top_n=top_n, compare_to=compare_to,
                    extra_metrics=extra_metrics, ascending=ascending, companies=companies, groups=groups,
                    exclude_companies=exclude_companies, line=line, policy_types=policy_types,
                    wind_only=wind_only, raw=raw)

    @mcp.tool(annotations=RO, structured_output=False)
    def company_profile(
        company: Annotated[str | None, Field(description="Company name or NAIC")] = None,
        group: Annotated[str | None, Field(description="Or a carrier group name")] = None,
        period: Period = "latest",
        raw: Raw = False,
    ) -> str:
        """One-call carrier (or group) summary: key metrics with QoQ/YoY, statewide rank and share, commercial vs personal split, policy-type mix with QoQ, 8-quarter trend, group members."""
        return _run(E.company_profile, company=company, group=group, period=period, raw=raw)

    @mcp.tool(annotations=RO, structured_output=False)
    def market_overview(
        period: Period = "latest",
        top_n: Annotated[int, Field(description="Movers per direction")] = 5,
        companies: Companies = None,
        groups: Groups = None,
        exclude_companies: Exclude = None,
        line: Line = None,
        policy_types: PolicyTypes = None,
        wind_only: WindOnly = None,
        raw: Raw = False,
    ) -> str:
        """Quarter headline for the market (or any slice): totals with QoQ/YoY and commercial/personal split, biggest TIV and PIF movers, largest carriers by TIV."""
        return _run(E.market_overview, period=period, top_n=top_n, companies=companies, groups=groups,
                    exclude_companies=exclude_companies, line=line, policy_types=policy_types,
                    wind_only=wind_only, raw=raw)

    @mcp.tool(annotations=RO, structured_output=False)
    def run_sql(
        query: Annotated[str, Field(description="A single read-only SELECT/WITH statement")],
        limit: int = 200,
    ) -> str:
        """Escape hatch: read-only SQLite over the normalized tables. Prefer the other tools. Main table: facts(period, idx, naic, group_id, pt_id, line, product, wind_only, <metric columns>); also companies, groups, policy_types, periods, metrics. A bad query returns the full schema."""
        return _run(E.run_sql, query, limit=limit)

    return mcp


mcp = build_server()
