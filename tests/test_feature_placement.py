"""feature(add, before=..., folder=...): added features are moved in one native reorder and the result is checked."""
import asyncio
import json

import pytest

from onshape_native import server
from onshape_native.client import OnshapeError

URL = "https://cad.onshape.com/documents/" + "a" * 24 + "/w/" + "b" * 24 + "/e/" + "c" * 24
ROWS = [{"id": "root", "kind": "feature_root", "parent_id": None},
        {"id": "feature:F1", "kind": "feature", "feature_id": "F1", "name": "Sketch 1", "parent_id": "root"},
        {"id": "feature_folder:FD", "kind": "feature_folder", "name": "s288 variables", "parent_id": "root"},
        {"id": "feature:FV", "kind": "feature", "feature_id": "FV", "name": "var", "parent_id": "feature_folder:FD"},
        {"id": "feature:F2", "kind": "feature", "feature_id": "F2", "name": "Extrude 1", "parent_id": "root"},
        {"id": "feature:NEW1", "kind": "feature", "feature_id": "NEW1", "name": "a", "parent_id": "root"},
        {"id": "feature:NEW2", "kind": "feature", "feature_id": "NEW2", "name": "b", "parent_id": "root"}]


class FakeStore:
    def put(self, value):
        return {"artifact": "tree.json", "path": "/tmp/tree.json"}

    def response(self, value):
        return value


class FakeService:
    def __init__(self, completed, stopped=False):
        self.store, self.completed, self.stopped, self.locks = FakeStore(), completed, stopped, {}

    async def feature(self, snapshot, action, changes):
        out = {"completed": [{"id": i, "state": {"featureStatus": "OK"}} for i in self.completed]}
        return {**out, "stopped": True} if self.stopped else out

    def snapshot_data(self, snapshot):
        return {"url": URL, "target": {"did": "a" * 24, "wvmid": "b" * 24}}


class FakeStructures:
    moves = []

    def __init__(self, service):
        pass

    async def capture_element(self, url):
        return {"rows": ROWS}

    async def sidebar_edit(self, snapshot, action, node_ids=None, name="", parent_id="root", before_id="", parameters=None,
                           definition=None, allow_reorder=False, delete_contents=False):
        FakeStructures.moves.append((action, node_ids, parent_id, before_id, allow_reorder))
        return {"structure_verified": True, "snapshot": "after.json", "regeneration_errors": []}


@pytest.fixture
def placed(monkeypatch):
    FakeStructures.moves = []
    monkeypatch.setattr(server, "Structures", FakeStructures)

    def use(service):
        monkeypatch.setattr(server, "svc", lambda: service)
    return use


def run(**kw):
    return json.loads(asyncio.run(server.feature("snap.json", "add", [{}, {}], **kw)))


def test_before_moves_every_added_feature_in_one_reorder(placed):
    placed(FakeService(["NEW1", "NEW2"]))
    out = run(before="F2")
    assert FakeStructures.moves == [("move", ["feature:NEW1", "feature:NEW2"], "root", "feature:F2", True)]
    assert out["placement"]["structure_verified"] is True and out["placement"]["regeneration_errors"] == []


def test_folder_by_name_places_at_its_end_or_before_a_feature_inside_it(placed):
    placed(FakeService(["NEW1"]))
    run(folder="s288 variables")
    run(folder="feature_folder:FD", before="FV")
    assert FakeStructures.moves == [("move", ["feature:NEW1"], "feature_folder:FD", "", True),
                                    ("move", ["feature:NEW1"], "feature_folder:FD", "feature:FV", True)]


def test_a_stopped_batch_is_not_moved(placed):
    placed(FakeService(["NEW1"], stopped=True))
    out = run(before="F2")
    assert FakeStructures.moves == [] and "not moved" in out["placement"]


@pytest.mark.parametrize("kw, message", [({"before": "NOPE"}, "before"), ({"folder": "missing"}, "folder"),
                                         ({"folder": "s288 variables", "before": "F2"}, "inside that folder")])
def test_unknown_or_inconsistent_targets_are_refused_after_the_add(placed, kw, message):
    placed(FakeService(["NEW1"]))
    with pytest.raises(OnshapeError, match=message):
        run(**kw)


def test_placement_only_applies_to_add():
    with pytest.raises(OnshapeError, match="only for add"):
        asyncio.run(server.feature("snap.json", "edit", [{"id": "F1"}], before="F2"))
