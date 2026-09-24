import os
import shutil

import pytest

from flpc import engine as E
from flpc import metrics as M
from flpc.catalog import get_catalog
from flpc.fmt import UserError


def col(resp, name, table=0):
    t = resp.tables[table]
    i = t.columns.index(name)
    return [r[i] for r in t.rows]


def test_totals_match_published_total_row(store):
    """Body sums reproduce FLOIR's own 'Total' row for every quarter."""
    con = store.connect()
    pub = {r["period"]: r["value"] for r in con.execute(
        "SELECT period, value FROM published_totals WHERE file_type='B' AND metric='pif'")}
    con.close()
    agg = E.aggregate(store, ["pif"], [], E.Filters(), [i for _, i in store.periods])[()]
    for p, i in store.periods:
        assert agg[i]["pif"] == pytest.approx(pub[p]), p


def test_commercial_tiv_series(store):
    r = E.timeseries(store, ["tiv"], line="commercial", raw=True)
    t = r.tables[0]
    vals = dict(zip(t.columns[1:], t.rows[0][1:]))
    assert vals["2026Q1"] == pytest.approx(250_624_212_371, rel=1e-9)
    assert vals["2022Q2"] == pytest.approx(147.4e9, rel=1e-3)


def test_compare_contributions_sum_to_net(store):
    r = E.compare_periods(store, "tiv", "2025Q4", "2026Q1", line="commercial", top_n=1000, raw=True)
    rows = r.tables[0].rows
    body, total = rows[:-1], rows[-1]
    assert sum(x[-3] for x in body) == pytest.approx(total[-3])
    assert sum(x[-1] for x in body) == pytest.approx(100, abs=0.5)


def test_drilldown_company_by_policy_type(store):
    r = E.compare_periods(store, "tiv", "2025Q4", "2026Q1", companies=["American Integrity"],
                          line="commercial", group_by="policy_type")
    assert "12841" in r.context[0]
    pts = col(r, "policy_type")
    assert pts[0] == "c_condo_assoc_wind" and pts[-1] == "Total"


def test_company_resolution(store):
    assert E.resolve_company(store, "American Integrity") == "12841"
    assert E.resolve_company(store, "10064") == "10064"
    assert E.resolve_company(store, "citizens property insurance corp") == "10064"
    with pytest.raises(UserError, match="Universal Insurance Holdings"):
        E.resolve_company(store, "Universal")
    with pytest.raises(UserError, match="Did you mean"):
        E.resolve_company(store, "Amercan Integrty")
    # comma inside a legal name is not a list separator
    f = E.make_filters(store, companies="HOMEOWNERS CHOICE PROPERTY & CASUALTY INSURANCE COMPANY, INC.")
    assert f.naics == ["12944"]


def test_group_resolution_and_profile(store):
    assert E.resolve_group(store, "universal") == "universal_insurance_holdings"
    assert E.resolve_group(store, "Tower Hill Insurance Exchange") == "tower_hill"
    r = E.company_profile(store, "Universal")            # ambiguous company -> group
    assert r.title.startswith("Profile: Universal Insurance Holdings")
    assert any(t.title == "Members" and len(t.rows) == 2 for t in r.tables)


def test_policy_type_and_period_parsing(store):
    assert set(E.resolve_policy_types(store, "cmp")) == {"c_cmp_condo_assoc", "c_cmp_excl_condo_assoc"}
    assert E.resolve_policy_types(store, ["p_ho"]) == ["p_ho"]                  # exact id
    assert sorted(E.resolve_policy_types(store, "ho")) == ["p_ho", "p_ho_wind"]  # product family
    assert len(E.resolve_policy_types(store, "c_")) == 9                         # id prefix
    last = store.latest_idx
    assert E.parse_period(store, "latest") == last
    assert E.parse_period(store, "latest-4") == last - 4
    assert E.parse_period(store, "Q1 2026") == E.parse_period(store, "2026-q1") == 2026 * 4
    with pytest.raises(UserError, match="not in the data"):
        E.parse_period(store, "2019Q1")


def test_derived_metric_is_ratio_of_sums(store):
    i = E.parse_period(store, "2026Q1")
    s = E.aggregate(store, ["dpw", "pif"], [], E.make_filters(store, companies=["12841"]), [i])[()][i]
    r = E.rank(store, "avg_premium", period="2026Q1", companies=["12841"], raw=True)
    assert r.tables[0].rows[0][3] == round(s["dpw"] / s["pif"])


def test_metric_availability(store):
    with pytest.raises(UserError, match="only reported"):
        E.rank(store, "claims_opened", period="2022Q3")
    assert M.get("exposure").id == "tiv"


def test_share_transform_sums_to_100(store):
    r = E.timeseries(store, "pif", group_by="line", transform="share", top_n=5)
    rows = [x for x in r.tables[0].rows if x[0] in ("commercial", "personal")]
    assert sum(x[-1] for x in rows) == pytest.approx(100, abs=0.2)


def test_tools_render(store):
    for resp in (get_catalog(store), E.market_overview(store), E.find_companies(store, "tower hill"),
                 E.company_profile(store, "Slide"), E.rank(store, "dpw", compare_to="latest-4")):
        txt = resp.to_text()
        assert txt.startswith("## ") and len(txt) < 12000
        assert resp.to_json()["tables"]


def test_sql_is_read_only(store):
    assert E.run_sql(store, "SELECT COUNT(*) AS n FROM companies").tables[0].rows[0][0] > 100
    for bad in ("DELETE FROM facts", "SELECT 1; DROP TABLE facts", "WITH x AS (SELECT 1) DELETE FROM facts"):
        with pytest.raises(UserError):
            E.run_sql(store, bad)
    with pytest.raises(UserError):
        E.run_sql(store, "SELECT * FROM pragma_table_info('facts') WHERE 0; ATTACH 'x' AS y")


def test_new_quarter_auto_reload(tmp_inputs, tmp_path):
    """Dropping a new quarter's workbook in the folder extends the data."""
    from flpc.store import Store

    s = Store(input_dirs=[str(tmp_inputs)], db_path=str(tmp_path / "db.sqlite"), reload_interval=0)
    assert s.periods[-1][0] == "2026Q1"
    src = next(p for p in os.listdir(tmp_inputs) if "policy_type_2026q1" in p)
    shutil.copy(tmp_inputs / src, tmp_inputs / src.replace("2026q1_20260507", "2026q2_20260807"))
    s.ensure()
    assert s.periods[-1][0] == "2026Q2"
    r = E.compare_periods(s, "tiv", "latest-1", "latest", line="commercial")
    assert r.tables[0].rows[-1][-3] == 0          # synthetic Q2 == Q1 -> no change
