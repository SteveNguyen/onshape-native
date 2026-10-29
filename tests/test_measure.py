"""measure_fit: Onshape's Measure replies (shapes as observed live 2026-10-29) turned into fit numbers."""
import math

import pytest

from onshape_native import measure
from onshape_native.client import OnshapeError


def reply(*items, error=0):
    """A ui.GBTUiMeasureEntitiesResponse with (measurementId, value in metres or radians) items."""
    return {"$type": "ui.GBTUiMeasureEntitiesResponse", "error": error,
            "measurements": [{"measurementId": name, "value": value, "startPoint": {"x": 0, "y": 0, "z": 0}} for name, value in items]}


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


def test_values_are_read_by_measurement_name_and_errors_are_refused():
    assert measure.values(cylinder(0.01)) == {"area": 1e-4, "diameter": 0.01, "radius": 0.005}
    with pytest.raises(OnshapeError, match="error 17"):
        measure.values(reply(error=17))


def test_cylinder_fit_gives_diametral_clearance_and_axis_offset():
    # Bore 10.2, shaft 10.0, axes parallel, tightest radial gap 0.06 => offset 0.1 - 0.06 = 0.04.
    pair = reply(("Min dist:", 0.00006), ("Max dist:", 0.03), ("Angle:", 0.0))
    out = measure.fit(cylinder(0.0102), cylinder(0.01), pair, expect_mm=[0.15, 0.25])
    assert out["kind"] == "cylindrical"
    assert out["bore_d_mm"] == 10.2 and out["shaft_d_mm"] == 10.0
    assert out["diametral_clearance_mm"] == pytest.approx(0.2)
    assert out["min_radial_gap_mm"] == pytest.approx(0.06) and out["axis_offset_mm"] == pytest.approx(0.04)
    assert out["checked"] == "diametral_clearance_mm" and out["in_range"] is True


def test_touching_cylinders_have_no_derivable_axis_offset():
    pair = reply(("Min dist:", 0.0), ("Angle:", 0.0))
    out = measure.fit(cylinder(0.0102), cylinder(0.01), pair)
    assert out["axis_offset_mm"] is None and "touch" in out["note"]


def test_tilted_cylinders_report_the_angle_and_no_axis_offset():
    pair = reply(("Min dist:", 0.00005), ("Angle:", math.radians(2)))
    out = measure.fit(cylinder(0.0102), cylinder(0.01), pair)
    assert out["angle_deg"] == pytest.approx(2) and out["axis_offset_mm"] is None


def test_parallel_flat_faces_give_the_gap_and_check_it():
    pair = reply(("Min dist:", 0.015), ("Max dist:", 0.048), ("Angle:", 0.0))
    out = measure.fit(FLAT, FLAT, pair, expect_mm=[0.1, 0.3])
    assert out["kind"] == "parallel" and out["gap_mm"] == pytest.approx(15)
    assert out["checked"] == "gap_mm" and out["in_range"] is False


def test_other_pairs_report_the_measured_distances_only():
    out = measure.fit(cylinder(0.01), FLAT, reply(("Min dist:", 0.002), ("Angle:", math.radians(90))))
    assert out["kind"] == "general" and out["min_dist_mm"] == pytest.approx(2) and out["angle_deg"] == pytest.approx(90)
    assert "gap_mm" not in out and "in_range" not in out


@pytest.mark.parametrize("expect", [[0.3, 0.1], [0.1], ["a", 1], [0.1, math.inf]])
def test_expect_must_be_an_ordered_finite_range(expect):
    with pytest.raises(OnshapeError):
        measure.fit(FLAT, FLAT, reply(("Min dist:", 0.0), ("Angle:", 0.0)), expect_mm=expect)


def test_tool_measures_each_face_then_the_pair_and_reports_the_revision(monkeypatch):
    import asyncio
    import json
    from onshape_native import server

    sent = []

    class Client:
        async def command(self, job):
            sent.append(job)
            n = len(job["body"]["entityQueries"])
            result = cylinder(0.0102 if len(sent) == 1 else 0.01) if n == 1 else reply(("Min dist:", 0.00006), ("Angle:", 0.0))
            return {"result": result, "microversion_before": "m1", "microversion_after": "m1"}

    class Store:
        def response(self, value):
            return value

    class Service:
        client, store = Client(), Store()

    monkeypatch.setattr(server, "svc", lambda: Service)
    monkeypatch.setattr(server, "native_target", lambda url: {"did": "a" * 24, "wid": "b" * 24, "eid": "c" * 24})
    url = "https://cad.onshape.com/documents/" + "a" * 24 + "/w/" + "b" * 24 + "/e/" + "c" * 24
    out = json.loads(asyncio.run(server.measure_fit(url, {"face_id": "JOC", "occurrence_path": ["Mbore"]},
                                                    {"face_id": "JIC", "occurrence_path": ["Mshaft"]}, expect_mm=[0.15, 0.25])))
    assert [len(j["body"]["entityQueries"]) for j in sent] == [1, 1, 2]
    assert all(j["command"] == "ui.GBTUiMeasureCall" and j["kind"] == "native" for j in sent)
    assert [q["path"] for q in sent[2]["body"]["entityQueries"]] == [["Mbore"], ["Mshaft"]]
    assert out["kind"] == "cylindrical" and out["in_range"] is True and out["revision_unchanged"] is True
