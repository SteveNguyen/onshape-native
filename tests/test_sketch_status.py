import asyncio
import dataclasses

from onshape_native.client import Settings
from onshape_native.service import Service

URL = "https://cad.onshape.com/documents/" + "a" * 24 + "/w/" + "b" * 24 + "/e/" + "c" * 24
FEATURES = {"sourceMicroversion": "d" * 24, "libraryVersion": 1, "serializationVersion": "1",
            "features": [{"featureId": "Fsk1", "name": "Sketch 1", "featureType": "newSketch", "parameters": []},
                         {"featureId": "Fsk2", "name": "Sketch 2", "featureType": "newSketch", "parameters": []},
                         {"featureId": "Fex", "name": "Extrude 1", "featureType": "extrude", "parameters": []}],
            "featureStates": {k: {"featureStatus": "OK"} for k in ("Fsk1", "Fsk2", "Fex")}}
# Sketch 2 reports WELL_DEFINED overall but keeps one free point: the entity level is the stricter check.
SKETCHES = {"sketches": [
    {"featureId": "Fsk1", "sketchSolveStatus": "WELL_DEFINED", "entities": [{"sketchEntityId": "c0", "entitySolveStatus": "WELL_DEFINED"},
                                                                            {"sketchEntityId": "used", "entitySolveStatus": "FIXED"}]},
    {"featureId": "Fsk2", "sketchSolveStatus": "WELL_DEFINED", "entities": [{"sketchEntityId": "l1", "entitySolveStatus": "WELL_DEFINED"},
                                                                            {"sketchEntityId": "l1.end", "entitySolveStatus": "UNDERDEFINED"}]}]}


def service(tmp_path, calls):
    s = Service(dataclasses.replace(Settings.load(), cache_dir=tmp_path))

    async def call(operation, path=None, query=None, body=None):
        calls.append((operation, query))
        return {"getPartStudioFeatures": FEATURES, "getSketchInfo": SKETCHES, "getPartsWMVE": []}[operation]

    async def evaluate(data, script, queries=None):
        return {"result": []}
    s.call, s.eval = call, evaluate
    return s


def test_inspect_reports_sketch_solve_status_per_entity(tmp_path):
    calls = []
    out = asyncio.run(service(tmp_path, calls).inspect(URL))
    rows = {f["id"]: f for f in out["features"]}
    assert rows["Fsk1"]["sketch_status"] == "WELL_DEFINED" and "sketch_not_well_defined" not in rows["Fsk1"]
    assert rows["Fsk2"]["sketch_status"] == "WELL_DEFINED"
    assert rows["Fsk2"]["sketch_not_well_defined"] == [{"entity": "l1.end", "status": "UNDERDEFINED"}]
    assert "sketch_status" not in rows["Fex"]
    assert out["sketch_issues"] == [{"id": "Fsk2", "name": "Sketch 2", "sketch_status": "WELL_DEFINED",
                                     "sketch_not_well_defined": [{"entity": "l1.end", "status": "UNDERDEFINED"}]}]
    # Sketch info is read at the same pinned microversion as the features.
    assert ("getSketchInfo", {"output3D": "false"}) in calls


def test_light_inspect_skips_sketch_info(tmp_path):
    calls = []
    out = asyncio.run(service(tmp_path, calls).inspect(URL, geometry=False))
    assert [c[0] for c in calls] == ["getPartStudioFeatures"]
    assert "sketch_issues" not in out
