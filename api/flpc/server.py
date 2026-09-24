"""HTTP server: MCP (streamable HTTP at /mcp) + REST API (/api/*) + OpenAPI.

One long-running container serves every channel:
  * Claude (custom connector), ChatGPT (connector / developer mode), Claude
    Code, any MCP client  ->  POST /mcp
  * ChatGPT Custom GPT Actions, scripts, n8n, dashboards  ->  /api/* (OpenAPI
    at /openapi.json)
"""

from __future__ import annotations

import contextlib
import hmac
import json
import re
from typing import Literal
from urllib.parse import parse_qs

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from . import __version__, config
from . import engine as E
from .catalog import get_catalog
from .fmt import UserError
from .mcp_server import INSTRUCTIONS, get_store, mcp

# --------------------------------------------------------------------------- #
# Auth (optional shared key)
# --------------------------------------------------------------------------- #

OPEN_PATHS = {"/", "/health", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}


class ApiKeyMiddleware:
    """Accept the key as Bearer token, X-API-Key header, ?key= or /k/<key>/ prefix."""

    def __init__(self, app, key: str):
        self.app, self.key = app, key

    def _ok(self, candidate: str) -> bool:
        return bool(candidate) and hmac.compare_digest(candidate.encode(), self.key.encode())

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.key:
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        m = re.match(r"^/k/([^/]+)(/.*)?$", path)
        if m:
            if not self._ok(m.group(1)):
                return await self._deny(send)
            scope = dict(scope)
            scope["path"] = m.group(2) or "/"
            scope["raw_path"] = scope["path"].encode()
            return await self.app(scope, receive, send)
        if path in OPEN_PATHS:
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        auth = headers.get("authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        qkey = (parse_qs(scope.get("query_string", b"").decode()).get("key") or [""])[0]
        if self._ok(token) or self._ok(headers.get("x-api-key", "")) or self._ok(qkey):
            return await self.app(scope, receive, send)
        return await self._deny(send)

    @staticmethod
    async def _deny(send):
        body = json.dumps({"error": "unauthorized: missing or bad API key"}).encode()
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b"Bearer")]})
        await send({"type": "http.response.body", "body": body})


# --------------------------------------------------------------------------- #
# REST request models
# --------------------------------------------------------------------------- #

StrList = list[str] | str | None


class SliceFilters(BaseModel):
    companies: StrList = Field(None, description="Company names or NAIC codes (fuzzy)")
    groups: StrList = Field(None, description="Carrier group names")
    exclude_companies: StrList = Field(None, description="Companies to exclude, e.g. ['Citizens']")
    line: Literal["commercial", "personal", "all"] | None = Field(None, description="Line of business")
    policy_types: StrList = Field(None, description="Policy type ids / product families (see catalog)")
    wind_only: bool | None = Field(None, description="true = only wind-only policy types; false = exclude them")
    raw: bool = Field(False, description="Unscaled raw dollars")

    def filters(self) -> dict:
        return {k: getattr(self, k) for k in
                ("companies", "groups", "exclude_companies", "line", "policy_types", "wind_only")}


class TimeseriesReq(SliceFilters):
    metrics: list[str] | str = Field(..., description="Metric id(s), e.g. ['tiv']")
    group_by: StrList = Field(None, description="company|group|line|policy_type|product|wind_only (max 2)")
    start: str | None = Field(None, description="First period, e.g. '2024Q1' (default: earliest)")
    end: str | None = Field(None, description="Last period (default: latest)")
    transform: Literal["value", "qoq", "yoy", "diff", "share"] = "value"
    top_n: int = 10


class CompareReq(SliceFilters):
    metric: str = Field(..., description="Metric id, e.g. 'tiv'")
    period_from: str = "latest-1"
    period_to: str = "latest"
    group_by: StrList = "company"
    top_n: int = 15


class RankReq(SliceFilters):
    metric: str = Field(..., description="Metric id to rank by")
    period: str = "latest"
    group_by: StrList = "company"
    top_n: int = 20
    compare_to: str | None = Field(None, description="Earlier period for change columns")
    extra_metrics: StrList = None
    ascending: bool = False


class ProfileReq(BaseModel):
    company: str | None = Field(None, description="Company name or NAIC")
    group: str | None = Field(None, description="Or a carrier group")
    period: str = "latest"
    raw: bool = False


class OverviewReq(SliceFilters):
    period: str = "latest"
    top_n: int = 5


class FindReq(BaseModel):
    query: str
    limit: int = 10


class SqlReq(BaseModel):
    query: str = Field(..., description="Single read-only SELECT/WITH statement")
    limit: int = 200


Fmt = Query("json", pattern="^(json|text)$", description="json (tables) or text (compact CSV)")


def _respond(fn, fmt, *args, **kw):
    try:
        res = fn(get_store(), *args, **kw)
    except UserError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if fmt == "text":
        return PlainTextResponse(res.to_text())
    return JSONResponse(res.to_json())


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #

def create_app() -> FastAPI:
    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        host=config.HOST,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        get_store()                                   # build/load data before serving
        async with mcp.session_manager.run():
            yield

    servers = [{"url": config.PUBLIC_URL}] if config.PUBLIC_URL else None
    app = FastAPI(
        title="Florida P&C Market Data API",
        version=__version__,
        description=INSTRUCTIONS + "\n\nAll data endpoints accept `?format=text` for compact CSV output.",
        lifespan=lifespan,
        servers=servers,
    )

    @app.get("/", include_in_schema=False)
    def root():
        return {"name": "florida-pc", "version": __version__, "mcp": "/mcp", "rest": "/api", "openapi": "/openapi.json",
                "health": "/health"}

    @app.get("/health", include_in_schema=False)
    def health():
        s = get_store()
        return {"ok": True, "latest_period": s.periods[-1][0], "periods": len(s.periods),
                "built": s.meta.get("generated_at"), "error": s.last_error}

    @app.get("/api/catalog", operation_id="getCatalog",
             summary="Everything available: periods, metrics, policy types, groups, syntax, workflow. Call first.")
    def catalog(format: str = Fmt):
        return _respond(get_catalog, format)

    @app.post("/api/find_companies", operation_id="findCompanies",
              summary="Search companies by name/former name/group/NAIC")
    def find(req: FindReq, format: str = Fmt):
        return _respond(E.find_companies, format, req.query, limit=req.limit)

    @app.post("/api/timeseries", operation_id="timeseries",
              summary="Metric(s) over quarters for any slice, optionally split by a dimension")
    def ts(req: TimeseriesReq, format: str = Fmt):
        return _respond(E.timeseries, format, req.metrics, group_by=req.group_by, start=req.start, end=req.end,
                        transform=req.transform, top_n=req.top_n, raw=req.raw, **req.filters())

    @app.post("/api/compare_periods", operation_id="comparePeriods",
              summary="Attribute the change in a metric between two quarters (who/what drove it)")
    def cmp(req: CompareReq, format: str = Fmt):
        return _respond(E.compare_periods, format, req.metric, period_from=req.period_from,
                        period_to=req.period_to, group_by=req.group_by, top_n=req.top_n, raw=req.raw,
                        **req.filters())

    @app.post("/api/rank", operation_id="rank", summary="League table / market share for one quarter")
    def rnk(req: RankReq, format: str = Fmt):
        return _respond(E.rank, format, req.metric, period=req.period, group_by=req.group_by, top_n=req.top_n,
                        compare_to=req.compare_to, extra_metrics=req.extra_metrics, ascending=req.ascending,
                        raw=req.raw, **req.filters())

    @app.post("/api/company_profile", operation_id="companyProfile",
              summary="One-call carrier or group summary")
    def profile(req: ProfileReq, format: str = Fmt):
        return _respond(E.company_profile, format, company=req.company, group=req.group, period=req.period,
                        raw=req.raw)

    @app.post("/api/market_overview", operation_id="marketOverview",
              summary="Quarter headline: totals, QoQ/YoY, movers, largest carriers")
    def overview(req: OverviewReq, format: str = Fmt):
        return _respond(E.market_overview, format, period=req.period, top_n=req.top_n, raw=req.raw,
                        **req.filters())

    @app.post("/api/sql", operation_id="runSql", summary="Read-only SQL over the normalized tables (escape hatch)")
    def sql(req: SqlReq, format: str = Fmt):
        return _respond(E.run_sql, format, req.query, limit=req.limit)

    app.mount("/", mcp_app)
    return ApiKeyMiddleware(app, config.API_KEY) if config.API_KEY else app


app = create_app()
