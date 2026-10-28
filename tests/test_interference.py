import asyncio
import json

import pytest

from onshape_native import server
from onshape_native.client import OnshapeError
from onshape_native.interference import request_body, summarize
from onshape_native.store import Store

URL = "https://cad.onshape.com/documents/" + "a" * 24 + "/w/" + "b" * 24 + "/e/" + "c" * 24


def body(size_m, origin_m):
    """A recorded-shape GBTInterferenceBody: box centred in its own frame, placed by a translation (metres)."""
    half = [v / 2 for v in size_m]
    m = {f"m{r}{c}": float(r == c) for r in range(3) for c in range(3)}
    m.update({"m03": origin_m[0], "m13": origin_m[1], "m23": origin_m[2], "$type": "math.GBTBSMatrix"})
    return {"$type": "GBTInterferenceBody", "displayData": {"faces": []},
            "boundingBox": {"$type": "math.GBTBoundingBox",
                            "minCorner": {"$type": "math.GBTVector3d", "x": -half[0], "y": -half[1], "z": -half[2]},
                            "maxCorner": {"$type": "math.GBTVector3d", "x": half[0], "y": half[1], "z": half[2]}},
            "boundingBoxTransform": m}


REPLY = {"$type": "ui.GBTUiInterferenceResponse", "error": 0,
         "interferences": [{"$type": "GBTUiAssemblyInterference", "interferenceBodiesKeys": ["k0", "k1"],
                            "occurrence1": {"$type": "assembly.GBTOccurrence", "path": ["Mservo"]},
                            "occurrence2": {"$type": "assembly.GBTOccurrence", "path": ["Msub", "Mbracket"]}}],
         "interferenceBodies": {"k0": body([0.006, 0.002, 0.0001], [0.102, 0.008, 0.2285]),
                                "k1": body([0.008, 0.008, 0.0002], [0.0989, 0.0, 0.211])}}
NAMES = {"Mservo": "servo <1>", "Msub": "frame <1>", "Mbracket": "bracket <2>"}


PART_REPLY = {"$type": "ui.GBTUiInterferenceResponse", "error": 0,
              "interferences": [{"$type": "GBTUiPartInterference", "interferenceBodiesKeys": ["JFD,JID,0"], "partId1": "JFD", "partId2": "JID"}],
              "interferenceBodies": {"JFD,JID,0": body([0.025, 0.01, 0.01], [0.0, 0.0, 0.0125])}}


def test_empty_selection_is_refused_because_it_checks_nothing():
    with pytest.raises(OnshapeError, match="checks nothing"):
        request_body([])
    with pytest.raises(OnshapeError, match="checks nothing"):
        request_body(part_ids=[])


def test_part_studio_request_and_summary_use_part_ids():
    b = request_body(part_ids=["JFD", "JID"])
    assert b["partIds"] == ["JFD", "JID"] and b["occurrences"] == []
    pair = summarize(PART_REPLY, {"JFD": "Part 1", "JID": "Part 2"})["interferences"][0]
    assert (pair["a"], pair["b"], pair["a_path"], pair["b_path"]) == ("Part 1", "Part 2", ["JFD"], ["JID"])
    assert pair["overlaps"][0]["min_mm"] == [-12.5, -5.0, 7.5] and pair["overlaps"][0]["max_mm"] == [12.5, 5.0, 17.5]


def test_request_body_types_each_occurrence_path():
    b = request_body([["M1"], ["M2", "M3"]])
    assert b["occurrences"] == [{"$type": "assembly.GBTOccurrence", "path": ["M1"]}, {"$type": "assembly.GBTOccurrence", "path": ["M2", "M3"]}]
    assert b["partIds"] == [] and b["includeStandardContent"] is False and b["excludeInterfereWithinSubassembly"] is False


def test_summary_names_pairs_and_places_overlaps_in_mm():
    out = summarize(REPLY, NAMES)
    assert out["error"] == 0 and out["pair_count"] == 1
    pair = out["interferences"][0]
    assert pair["a"] == "servo <1>" and pair["b"] == "frame <1> / bracket <2>"
    assert pair["a_path"] == ["Mservo"] and pair["b_path"] == ["Msub", "Mbracket"]
    first = pair["overlaps"][0]
    assert first["size_mm"] == [6.0, 2.0, 0.1]
    assert first["min_mm"] == [99.0, 7.0, 228.45] and first["max_mm"] == [105.0, 9.0, 228.55]
    assert pair["overlaps"][1]["size_mm"] == [8.0, 8.0, 0.2]
    # Tessellated display data is dropped: it is large and not needed for a report.
    assert "displayData" not in json.dumps(out)


def test_no_interference_summary():
    out = summarize({"$type": "ui.GBTUiInterferenceResponse", "error": 0, "interferences": [], "interferenceBodies": {}}, NAMES)
    assert out == {"error": 0, "pair_count": 0, "interferences": []}


class FakeClient:
    def __init__(self, reply):
        self.reply, self.jobs = reply, []

    async def command(self, job):
        self.jobs.append(job)
        return {"result": self.reply, "microversion_before": "d" * 24, "microversion_after": "d" * 24}


class FakeService:
    def __init__(self, tmp_path, reply, kind="ASSEMBLY"):
        self.client, self.store, self.calls, self.kind = FakeClient(reply), Store(tmp_path), [], kind

    def target(self, url):
        return {"did": "a" * 24, "wvm": "w", "wvmid": "b" * 24, "eid": "c" * 24}, ""

    async def call(self, operation, path=None, query=None, body=None):
        if operation == "getElementsInDocument":
            return [{"id": "c" * 24, "elementType": self.kind}]
        self.calls.append((operation, query))
        if operation == "getPartsWMVE":
            return [{"partId": "JFD", "name": "Part 1", "bodyType": "solid"}, {"partId": "JID", "name": "Part 2", "bodyType": "solid"},
                    {"partId": "JKD", "name": "Sketch surface", "bodyType": "sheet"}, {"partId": "JGD", "name": "Group", "bodyType": "solid", "isCompositePart": True}]
        return {"rootAssembly":{"instances": [{"id": "Mservo", "name": "servo <1>"}, {"id": "Msub", "name": "frame <1>"}],
                                 "occurrences": [{"path": ["Mservo"]}, {"path": ["Msub"]}, {"path": ["Msub", "Mbracket"]}]},
                "subAssemblies": [{"instances": [{"id": "Mbracket", "name": "bracket <2>"}]}]}


def test_tool_checks_every_top_level_occurrence_and_reports_by_name(tmp_path, monkeypatch):
    fake = FakeService(tmp_path, REPLY)
    monkeypatch.setattr(server, "svc", lambda: fake)
    out = json.loads(asyncio.run(server.interference_check(URL)))
    data = out.get("data", out)
    assert data["pair_count"] == 1 and data["interferences"][0]["b"] == "frame <1> / bracket <2>"
    assert data["checked_occurrences"] == 2 and data["revision_unchanged"] is True
    job = fake.client.jobs[0]
    assert job["kind"] == "native" and job["command"] == "ui.GBTUiInterferenceCall"
    assert [o["path"] for o in job["body"]["occurrences"]] == [["Mservo"], ["Msub"]]
    assert fake.calls[0] == ("getAssemblyDefinition", {"includeNonSolids": "true", "excludeSuppressed": "true"})


def test_tool_passes_explicit_occurrences(tmp_path, monkeypatch):
    fake = FakeService(tmp_path, REPLY)
    monkeypatch.setattr(server, "svc", lambda: fake)
    asyncio.run(server.interference_check(URL, occurrence_paths=[["Mservo"], ["Msub", "Mbracket"]]))
    assert [o["path"] for o in fake.client.jobs[0]["body"]["occurrences"]] == [["Mservo"], ["Msub", "Mbracket"]]


def test_tool_on_a_part_studio_checks_every_solid_part(tmp_path, monkeypatch):
    fake = FakeService(tmp_path, PART_REPLY, kind="PARTSTUDIO")
    monkeypatch.setattr(server, "svc", lambda: fake)
    data = json.loads(asyncio.run(server.interference_check(URL)))
    data = data.get("data", data)
    assert data["pair_count"] == 1 and (data["interferences"][0]["a"], data["interferences"][0]["b"]) == ("Part 1", "Part 2")
    assert data["checked_parts"] == 2 and data["revision_unchanged"] is True
    # Sheets and composite parts are not solids to check; composites would double-count their members.
    assert fake.client.jobs[0]["body"]["partIds"] == ["JFD", "JID"] and fake.client.jobs[0]["body"]["occurrences"] == []


def test_tool_refuses_other_element_types(tmp_path, monkeypatch):
    fake = FakeService(tmp_path, PART_REPLY, kind="DRAWING")
    monkeypatch.setattr(server, "svc", lambda: fake)
    with pytest.raises(OnshapeError, match="assembly or Part Studio"):
        asyncio.run(server.interference_check(URL))
