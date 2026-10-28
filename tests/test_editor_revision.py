"""inspect_model learns the current revision from the open editor (no REST) and reads features pinned to it."""
import asyncio
import dataclasses

from onshape_native.client import OnshapeError, Settings
from onshape_native.service import Service

D, W, E = "a" * 24, "b" * 24, "c" * 24
URL = f"https://cad.onshape.com/documents/{D}/w/{W}/e/{E}"
M1, M2 = "1" * 24, "2" * 24


def service(tmp_path, editor_micro):
    s = Service(dataclasses.replace(Settings.load(), cache_dir=tmp_path))
    s.rest = []

    async def command(job):
        if job["kind"] != "state":
            raise AssertionError(job)
        if editor_micro is None:
            raise OnshapeError("Open the exact target workspace/element in Comet.")
        return {"microversion": editor_micro(), "connected": True, "tree": {}}

    async def call(operation, path=None, query=None, body=None):
        s.rest.append((operation, path.get("wvm"), path.get("wvmid")))
        micro = path["wvmid"] if path.get("wvm") == "m" else M1
        return {"sourceMicroversion": micro, "libraryVersion": 1, "serializationVersion": "1", "features": [], "featureStates": {}}
    s.client.command, s.call = command, call
    return s


def test_unchanged_revision_costs_no_rest_call(tmp_path):
    s = service(tmp_path, lambda: M1)
    first = asyncio.run(s.inspect(URL, geometry=False))
    assert s.rest == [("getPartStudioFeatures", "m", M1)]  # pinned to the editor's revision, so cacheable
    again = asyncio.run(s.inspect(URL, geometry=False, previous=first["snapshot"]))
    assert again["unchanged"] is True and again["api_calls"] == 0 and len(s.rest) == 1


def test_changed_revision_reads_features_pinned_to_it(tmp_path):
    micro = [M1]
    s = service(tmp_path, lambda: micro[0])
    first = asyncio.run(s.inspect(URL, geometry=False))
    micro[0] = M2
    second = asyncio.run(s.inspect(URL, geometry=False, previous=first["snapshot"]))
    assert second["microversion"] == M2 and s.rest[-1] == ("getPartStudioFeatures", "m", M2)


def test_without_an_open_editor_it_falls_back_to_the_workspace_read(tmp_path):
    s = service(tmp_path, None)
    out = asyncio.run(s.inspect(URL, geometry=False))
    assert s.rest == [("getPartStudioFeatures", "w", W)] and out["microversion"] == M1


def test_an_editor_lagging_behind_our_own_write_is_not_trusted(tmp_path):
    s = service(tmp_path, lambda: M1)
    s.written[(D, W)] = M2  # this process just wrote M2 through REST; the editor still shows M1
    asyncio.run(s.inspect(URL, geometry=False))
    assert s.rest == [("getPartStudioFeatures", "w", W)]
