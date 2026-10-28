import asyncio

from onshape_native.client import Client, Settings

M = "1" * 24
PINNED = f"/api/v17/partstudios/d/{'a' * 24}/m/{M}/e/{'c' * 24}/features"
LIVE = f"/api/v17/partstudios/d/{'a' * 24}/w/{'b' * 24}/e/{'c' * 24}/features"


def client(replies=None):
    c = Client(Settings.load())
    c.sent = []

    async def command(job):
        c.sent.append(job)
        return {"status": 200, "body": {"n": len(c.sent), "nested": {"v": [1]}}, "response_headers": {}}
    c.command = command
    return c


def run(coro):
    return asyncio.run(coro)


def test_reads_pinned_to_a_revision_are_answered_from_the_cache():
    c = client()
    first = run(c.request("GET", PINNED, {"noSketchGeometry": True}))
    second = run(c.request("GET", PINNED, {"noSketchGeometry": True}))
    assert first == second and len(c.sent) == 1 and c.cache_hits == 1
    # A different query is a different request.
    run(c.request("GET", PINNED, {"noSketchGeometry": False}))
    assert len(c.sent) == 2


def test_workspace_reads_and_writes_are_never_cached():
    c = client()
    run(c.request("GET", LIVE)); run(c.request("GET", LIVE))
    run(c.request("POST", PINNED, body={"x": 1})); run(c.request("POST", PINNED, body={"x": 1}))
    assert len(c.sent) == 4 and c.cache_hits == 0


def test_featurescript_evaluation_at_a_revision_is_cached_by_its_inputs():
    c = client()
    path = f"/api/v17/partstudios/d/{'a' * 24}/m/{M}/e/{'c' * 24}/featurescript"
    run(c.request("POST", path, body={"script": "s1"}, read_only=True))
    run(c.request("POST", path, body={"script": "s1"}, read_only=True))
    run(c.request("POST", path, body={"script": "s2"}, read_only=True))
    assert len(c.sent) == 2


def test_cached_answers_are_copies_callers_cannot_corrupt():
    c = client()
    first = run(c.request("GET", PINNED))
    first["nested"]["v"].append(99)
    assert run(c.request("GET", PINNED))["nested"]["v"] == [1]


def test_errors_are_not_cached():
    c = Client(Settings.load())
    sent = []

    async def command(job):
        sent.append(job)
        return {"status": 404 if len(sent) == 1 else 200, "body": {}}
    c.command = command
    try:
        run(c.request("GET", PINNED))
    except Exception:
        pass
    run(c.request("GET", PINNED))
    assert len(sent) == 2


def test_the_cache_is_bounded():
    c = client()
    c.cache_limit = 3
    for i in range(5):
        run(c.request("GET", PINNED, {"i": i}))
    assert len(c.cache) == 3
    run(c.request("GET", PINNED, {"i": 0}))  # evicted: sent again
    assert len(c.sent) == 6
