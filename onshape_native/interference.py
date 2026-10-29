"""Onshape's own assembly interference check (the editor's ui.GBTUiInterferenceCall) and a compact report of its reply."""
from __future__ import annotations

from .client import OnshapeError

COMMAND = "ui.GBTUiInterferenceCall"


def request_body(paths=None, part_ids=None, include_standard_content=False):
    """Assemblies pass occurrence paths, Part Studios part IDs. The editor checks only what it is given:
    an empty selection returns no interferences, not "all clear"."""
    if not paths and not part_ids:
        raise OnshapeError("Pass the occurrences or parts to check; an empty selection checks nothing.")
    return {"occurrences": [{"$type": "assembly.GBTOccurrence", "path": list(p)} for p in paths or []], "partIds": list(part_ids or []),
            "includeStandardContent": include_standard_content, "excludeInterfereWithinSubassembly": False}


mm = lambda v: round(v * 1000, 4)


def _mul(a, b):
    """Product of two 4x4 row-major rigid transforms (16-lists)."""
    return [sum(a[4 * r + k] * b[4 * k + c] for k in range(4)) for r in range(4) for c in range(4)]


def _inverse(t):
    """Inverse of a rigid transform: transposed rotation, rotated and negated translation."""
    rt = [t[4 * c + r] for r in range(3) for c in range(3)]
    tr = [-sum(rt[3 * r + c] * t[4 * c + 3] for c in range(3)) for r in range(3)]
    return rt[0:3] + [tr[0]] + rt[3:6] + [tr[1]] + rt[6:9] + [tr[2]] + [0, 0, 0, 1]


def _corners(body, move=None):
    """World corners (metres) of an overlap body's box, optionally moved by a rigid transform."""
    lo, hi = body["boundingBox"]["minCorner"], body["boundingBox"]["maxCorner"]
    t = body["boundingBoxTransform"]
    place = [t[f"m{r}{c}"] for r in range(3) for c in range(4)] + [0, 0, 0, 1]
    if move:
        place = _mul(move, place)
    pts = [(x, y, z) for x in (lo["x"], hi["x"]) for y in (lo["y"], hi["y"]) for z in (lo["z"], hi["z"])]
    return [[sum(place[4 * r + c] * p[c] for c in range(3)) + place[4 * r + 3] for r in range(3)] for p in pts]


def overlap(body, move=None):
    """Size of one overlap body in its own frame and its element-frame bounding box, in mm."""
    lo, hi = body["boundingBox"]["minCorner"], body["boundingBox"]["maxCorner"]
    world = _corners(body, move)
    return {"size_mm": [mm(hi[k] - lo[k]) for k in "xyz"],
            "min_mm": [mm(min(p[i] for p in world)) for i in range(3)],
            "max_mm": [mm(max(p[i] for p in world)) for i in range(3)]}


def _reuse_move(pair, first, places, parts):
    """Onshape reuses one overlap body for every pair with the same geometry, placed at the first pair. The move from
    the first pair to this one must map both of its parts (same part definitions) consistently; None if it does not."""
    if not places or not parts:
        return None
    (a, b), (fa, fb) = pair, first
    for x, y, z, w in ((a, fa, b, fb), (a, fb, b, fa)):
        keys = [tuple(p) for p in (x, y, z, w)]
        if any(k not in places for k in keys) or parts.get(keys[0]) != parts.get(keys[1]) or parts.get(keys[2]) != parts.get(keys[3]):
            continue
        move = _mul(places[keys[0]], _inverse(places[keys[1]]))
        if all(abs(u - v) < 1e-6 for u, v in zip(_mul(move, places[keys[3]]), places[keys[2]])):
            return move
    return None


def summarize(reply, names, places=None, parts=None):
    """Interfering pairs by instance or part name (subassembly paths joined with ' / '); tessellated display data is dropped.
    places: {occurrence path tuple: 4x4 row-major transform in metres}; parts: {occurrence path tuple: part definition key}.
    With them, a body Onshape reused from an earlier pair is moved to this pair's own position."""
    label = lambda path: " / ".join(names.get(i, i) for i in path)
    bodies = reply.get("interferenceBodies") or {}
    pairs, first_use = [], {}
    for n, item in enumerate(reply.get("interferences") or []):
        if "partId1" in item:  # Part Studio pair (GBTUiPartInterference)
            a, b = [item["partId1"]], [item["partId2"]]
        else:  # assembly pair (GBTUiAssemblyInterference)
            a, b = item["occurrence1"]["path"], item["occurrence2"]["path"]
        overlaps = []
        for k in item.get("interferenceBodiesKeys", []):
            if k not in bodies:
                continue
            if k not in first_use:
                first_use[k] = (n, (a, b))
                overlaps.append(overlap(bodies[k]))
                continue
            j, first = first_use[k]
            move = _reuse_move((a, b), first, places, parts)
            if move:
                overlaps.append({**overlap(bodies[k], move), "shared_with_pair": j + 1})
            else:
                size = overlap(bodies[k])["size_mm"]
                overlaps.append({"size_mm": size, "shared_with_pair": j + 1,
                                 "position": f"same overlap shape as pair {j + 1}; its position here was not computed"})
        pairs.append({"a": label(a), "b": label(b), "a_path": a, "b_path": b, "overlaps": overlaps})
    return {"error": reply.get("error"), "pair_count": len(pairs), "interferences": pairs}
