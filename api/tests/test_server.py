import anyio
import pytest
from fastapi.testclient import TestClient

from flpc.mcp_server import mcp
from flpc.server import app

MCP_HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_auth(client):
    assert client.get("/health").status_code == 200
    assert client.get("/api/catalog").status_code == 401
    assert client.get("/api/catalog", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/catalog", headers={"Authorization": "Bearer test-key"}).status_code == 200
    assert client.get("/api/catalog", headers={"X-API-Key": "test-key"}).status_code == 200
    assert client.get("/api/catalog?key=test-key").status_code == 200
    assert client.get("/k/test-key/api/catalog").status_code == 200
    assert client.get("/k/wrong/api/catalog").status_code == 401
    assert client.post("/mcp", json=INIT, headers=MCP_HEADERS).status_code == 401


def test_rest_endpoints(client):
    h = {"X-API-Key": "test-key"}
    r = client.post("/api/compare_periods", headers=h,
                    json={"metric": "tiv", "period_from": "2025Q4", "period_to": "2026Q1", "line": "commercial"})
    assert r.status_code == 200 and r.json()["tables"][0]["rows"][-1][1] == "Total"
    r = client.post("/api/timeseries?format=text", headers=h, json={"metrics": ["pif"], "group_by": "line"})
    assert r.status_code == 200 and "commercial" in r.text
    r = client.post("/api/rank", headers=h, json={"metric": "nope"})
    assert r.status_code == 400 and "Unknown metric" in r.json()["error"]
    spec = client.get("/openapi.json").json()
    ops = {op["operationId"] for p in spec["paths"].values() for op in p.values()}
    assert {"getCatalog", "timeseries", "comparePeriods", "rank", "companyProfile", "marketOverview",
            "findCompanies", "runSql"} <= ops


def test_mcp_over_http_legacy_protocol(client):
    r = client.post("/k/test-key/mcp", json=INIT, headers=MCP_HEADERS)
    assert r.status_code == 200 and r.json()["result"]["serverInfo"]["name"] == "florida-pc"
    h = {**MCP_HEADERS, "Authorization": "Bearer test-key", "mcp-protocol-version": "2025-06-18"}
    tools = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=h).json()
    assert len(tools["result"]["tools"]) == 8
    call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "rank", "arguments": {"metric": "tiv", "line": "commercial", "top_n": 3}}}
    res = client.post("/mcp", json=call, headers=h).json()["result"]
    assert not res["isError"] and "AMERICAN COASTAL" in res["content"][0]["text"]


def test_mcp_client_in_process():
    from mcp import Client

    async def go():
        async with Client(mcp) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            assert "compare_periods" in names
            res = await c.call_tool("compare_periods", {"metric": "pif", "group_by": "group", "top_n": 3})
            assert not res.is_error and "Total" in res.content[0].text
            bad = await c.call_tool("timeseries", {"metrics": ["tiv"], "companies": "Universal"})
            assert bad.is_error and "matches 2 companies" in bad.content[0].text

    anyio.run(go)
