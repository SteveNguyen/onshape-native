"""measure_fit: Onshape's Measure replies (shapes as observed live 2026-10-29) turned into fit numbers."""
import asyncio
import json
import math

import pytest

from onshape_native import measure, server
from onshape_native.client import OnshapeError


TYPE = {"Min dist:": 4, "Max dist:": 3, "Angle:": 15, "Area:": 19, "Diameter:": 11, "Radius:": 12, "Parallel axis distance:": 7}


def reply(*items, error=0):
    """A ui.GBTUiMeasureEntitiesResponse with (measurementId, value in metres or radians) items."""
    return {"$type": "ui.GBTUiMeasureEntitiesResponse", "error": error,
            "measurements": [{"measurementId": name, "measurementType": TYPE[name], "value": value,
                              "startPoint": {"x": 0, "y": 0, "z": 0}} for name, value in items]}


def cylinder(d):
    return reply(("Area:", 1e-4), ("Diameter:", d), ("Radius:", d / 2))


FLAT = reply(("Area:", 3e-3))


def test_queries_follow_the_editor_selection_format():
    ps, asm = measure.query({"face_id": "JIC"}), measure.query({"face_id": "JOC", "occurrence_path": ["Mabc"]})
    assert ps["$type"] == "bsedit.GBTMIndividualQuery" and ps["deterministicIds"] == ["JIC"]
    assert asm["$type"] == "assembly.GBTMIndividualQueryWithOccurrence" and asm["path"] == ["Mabc"] and asm["deterministicIds"] == ["JOC"]
    assert ps["nodeId"] != measure.query({"face_id": "JIC"})["nodeId"]


@pytest.mark.parametrize("entity", [{}, {"face_id": ""}, {"face_id": "J C"}, {"face_id": "JOC", "occurrence_path": []},
                                    {"face_id": "JOC", "extra": 1}])
def test_malformed_entities_are_refused(entity):
    with pytest.raises(OnshapeError):
        measure.query(entity)


def test_values_are_keyed_by_measurement_type_and_errors_are_refused():
    assert measure.values(cylinder(0.01)) == {"area": 1e-4, "diameter": 0.01, "radius": 0.005}
    translated = {"error": 0, "measurements": [{"measurementId": "Dist. min :", "measurementType": 4, "value": 0.002}]}
    assert measure.values(translated) == {"min dist": 0.002}
    with pytest.raises(OnshapeError, match="error 17"):
        measure.values(reply(error=17))


def test_the_unreliable_angle_is_never_reported():
    # Live: Top vs Front planes (perpendicular) came back as Angle 0.
    out = measure.fit("planar", FLAT, FLAT, reply(("Angle:", 0.0)))
    assert "angle" not in out["measured"]["pair"] and "angle_deg" not in out


def test_cylinder_fit_gives_diametral_clearance_and_axis_offset():
    # Bore 10.2, shaft 10.0, tightest radial gap 0.06 => offset 0.1 - 0.06 = 0.04.
    pair = reply(("Min dist:", 0.00006), ("Max dist:", 0.03))
    out = measure.fit("cylinder", cylinder(0.0102), cylinder(0.01), pair, expect_mm=[0.15, 0.25])
    assert out["bore_d_mm"] == 10.2 and out["shaft_d_mm"] == 10.0
    assert out["diametral_clearance_mm"] == pytest.approx(0.2)
    assert out["min_radial_gap_mm"] == pytest.approx(0.06) and out["axis_offset_mm"] == pytest.approx(0.04)
    assert out["checked"] == "diametral_clearance_mm" and out["in_range"] is True


def test_axis_offset_measured_by_onshape_is_used_as_is():
    pair = reply(("Min dist:", 0.00006), ("Parallel axis distance:", 0.00003))
    out = measure.fit("cylinder", cylinder(0.0102), cylinder(0.01), pair)
    assert out["axis_offset_mm"] == pytest.approx(0.03) and "note" not in out


def test_touching_cylinders_have_no_derivable_axis_offset():
    out = measure.fit("cylinder", cylinder(0.0102), cylinder(0.01), reply(("Min dist:", 0.0)))
    assert out["axis_offset_mm"] is None and "touch" in out["note"]


def test_planar_fit_gives_the_gap_and_checks_it():
    pair = reply(("Min dist:", 0.015), ("Max dist:", 0.048))
    out = measure.fit("planar", FLAT, FLAT, pair, expect_mm=[0.1, 0.3])
    assert out["gap_mm"] == pytest.approx(15) and out["checked"] == "gap_mm" and out["in_range"] is False


@pytest.mark.parametrize("kind, a, b", [("cylinder", cylinder(0.01), FLAT), ("planar", cylinder(0.01), FLAT), ("conical", FLAT, FLAT)])
def test_faces_that_do_not_match_the_declared_fit_are_refused(kind, a, b):
    with pytest.raises(OnshapeError):
        measure.fit(kind, a, b, reply(("Min dist:", 0.001)))


@pytest.mark.parametrize("expect", [[0.3, 0.1], [0.1], ["a", 1], [0.1, math.inf]])
def test_expect_must_be_an_ordered_finite_range(expect):
    with pytest.raises(OnshapeError):
        measure.fit("planar", FLAT, FLAT, reply(("Min dist:", 0.0)), expect_mm=expect)


def tool(monkeypatch, sent):
    class Client:
        async def command(self, job):
            sent.append(job)
            n = len(job["body"]["entityQueries"])
            result = cylinder(0.0102 if len(sent) == 1 else 0.01) if n == 1 else reply(("Min dist:", 0.00006))
            return {"result": result, "microversion_before": "m1", "microversion_after": "m1"}

    class Store:
        def response(self, value):
            return value

    class Service:
        client, store = Client(), Store()

    monkeypatch.setattr(server, "svc", lambda: Service)
    monkeypatch.setattr(server, "native_target", lambda url: {"did": "a" * 24, "wid": "b" * 24, "eid": "c" * 24})
    return "https://cad.onshape.com/documents/" + "a" * 24 + "/w/" + "b" * 24 + "/e/" + "c" * 24


def test_tool_measures_each_face_then_the_pair_and_reports_the_revision(monkeypatch):
    sent = []
    url = tool(monkeypatch, sent)
    out = json.loads(asyncio.run(server.measure_fit(url, {"face_id": "JOC", "occurrence_path": ["Mbore"]},
                                                    {"face_id": "JIC", "occurrence_path": ["Mshaft"]}, "cylinder", expect_mm=[0.15, 0.25])))
    assert [len(j["body"]["entityQueries"]) for j in sent] == [1, 1, 2]
    assert all(j["command"] == "ui.GBTUiMeasureCall" and j["kind"] == "native" for j in sent)
    assert [q["path"] for q in sent[2]["body"]["entityQueries"]] == [["Mbore"], ["Mshaft"]]
    assert out["fit"] == "cylinder" and out["in_range"] is True and out["revision_unchanged"] is True


def test_tool_refuses_an_unknown_fit_before_measuring(monkeypatch):
    sent = []
    url = tool(monkeypatch, sent)
    with pytest.raises(OnshapeError):
        asyncio.run(server.measure_fit(url, {"face_id": "JOC"}, {"face_id": "JIC"}, "conical"))
    assert sent == []
