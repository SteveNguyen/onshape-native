"""Onshape's own assembly interference check (the editor's ui.GBTUiInterferenceCall) and a compact report of its reply."""
from __future__ import annotations

from .client import OnshapeError

COMMAND = "ui.GBTUiInterferenceCall"


def request_body(paths, include_standard_content=False):
    """The editor checks only the occurrences it is given: an empty list returns no interferences, not "all clear"."""
    if not paths:
        raise OnshapeError("Pass the occurrences to check; an empty selection checks nothing.")
    return {"occurrences": [{"$type": "assembly.GBTOccurrence", "path": list(p)} for p in paths], "partIds": [],
            "includeStandardContent": include_standard_content, "excludeInterfereWithinSubassembly": False}


def overlap(body):
    """Size of one overlap body in its own frame and its assembly-frame bounding box, in mm."""
    lo, hi = body["boundingBox"]["minCorner"], body["boundingBox"]["maxCorner"]
    t = body["boundingBoxTransform"]
    corners = [(x, y, z) for x in (lo["x"], hi["x"]) for y in (lo["y"], hi["y"]) for z in (lo["z"], hi["z"])]
    world = [[sum(t[f"m{r}{c}"] * p[c] for c in range(3)) + t[f"m{r}3"] for r in range(3)] for p in corners]
    mm = lambda v: round(v * 1000, 4)
    return {"size_mm": [mm(hi[k] - lo[k]) for k in "xyz"],
            "min_mm": [mm(min(p[i] for p in world)) for i in range(3)],
            "max_mm": [mm(max(p[i] for p in world)) for i in range(3)]}


def summarize(reply, names):
    """Interfering pairs by instance name (subassembly paths joined with ' / '); tessellated display data is dropped."""
    label = lambda path: " / ".join(names.get(i, i) for i in path)
    bodies = reply.get("interferenceBodies") or {}
    pairs = []
    for item in reply.get("interferences") or []:
        a, b = item["occurrence1"]["path"], item["occurrence2"]["path"]
        pairs.append({"a": label(a), "b": label(b), "a_path": a, "b_path": b,
                      "overlaps": [overlap(bodies[k]) for k in item.get("interferenceBodiesKeys", []) if k in bodies]})
    return {"error": reply.get("error"), "pair_count": len(pairs), "interferences": pairs}
