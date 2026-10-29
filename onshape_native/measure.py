"""Onshape's own Measure tool (the editor's ui.GBTUiMeasureCall) applied to one named fit.

Observed replies (2026-10-29): one cylinder gives Diameter/Radius/Area; two entities give Min dist, Max dist and Area,
all in metres and correct. Not usable: the Angle (0 for the perpendicular Top and Front planes) and the closest points
(always zeros). So the caller states the fit type, and no orientation is reported.
"""
from __future__ import annotations

import math
import re
import secrets

from .client import OnshapeError

COMMAND = "ui.GBTUiMeasureCall"
FACE_ID = re.compile(r"[A-Za-z0-9_.+/=-]{1,64}")
OCCURRENCE_ID = re.compile(r"[A-Za-z0-9+/=]{1,64}")
# The editor's measurement types (GBTMeasurementType); labels like "Min dist:" are translated, these are not.
TYPES = {0: "center position", 1: "position", 2: "center distance", 3: "max dist", 4: "min dist", 5: "perpendicular distance",
         6: "axis perpendicular distance", 7: "parallel axis distance", 8: "parallel distance", 9: "center axis distance",
         10: "length", 11: "diameter", 12: "radius", 13: "max radius", 14: "min radius", 19: "area"}
ANGLES = {15, 16, 17, 18, 20, 21, 22}  # angle types: not reliable in these replies

mm = lambda metres: round(metres * 1000, 6)


def query(entity):
    """The query the editor builds for a selected face: a bare face ID in a Part Studio, the face ID within its
    occurrence in an assembly."""
    if not isinstance(entity, dict) or set(entity) - {"face_id", "occurrence_path"} or not FACE_ID.fullmatch(str(entity.get("face_id", ""))):
        raise OnshapeError("Each entity is {face_id} (Part Studio) or {occurrence_path, face_id} (assembly).")
    node = "M" + "".join(secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") for _ in range(16))
    if "occurrence_path" not in entity:
        return {"$type": "bsedit.GBTMIndividualQuery", "nodeId": node, "deterministicIds": [entity["face_id"]]}
    path = entity["occurrence_path"]
    if not isinstance(path, list) or not 1 <= len(path) <= 20 or any(not isinstance(p, str) or not OCCURRENCE_ID.fullmatch(p) for p in path):
        raise OnshapeError("occurrence_path is the list of occurrence IDs from element_tree, top level first.")
    return {"$type": "assembly.GBTMIndividualQueryWithOccurrence", "nodeId": node, "path": list(path), "deterministicIds": [entity["face_id"]]}


def values(reply):
    """{'min dist': metres, 'diameter': metres, ...} from one Measure reply. The angle is left out: it is not reliable."""
    if reply.get("error"):
        raise OnshapeError(f"Onshape Measure refused the selection (error {reply['error']}); check the face IDs and occurrence paths.")
    return {TYPES.get(m.get("measurementType"), f"type {m.get('measurementType')}"): m["value"]
            for m in reply.get("measurements", []) if "value" in m and m.get("measurementType") not in ANGLES}


def fit(kind, single_a, single_b, pair, expect_mm=None):
    """Fit numbers from Measure on entity a alone, b alone, and both, for a fit the caller declares. 'cylinder': bore and
    shaft diameters, diametral clearance (checked by expect_mm), tightest radial gap, axis offset. 'planar': the gap
    between the faces (checked by expect_mm). Parallel axes or faces are the caller's premise; Measure cannot check it."""
    if kind not in ("cylinder", "planar"):
        raise OnshapeError('fit is "cylinder" (bore and shaft) or "planar" (two flat faces).')
    if expect_mm is not None and (not isinstance(expect_mm, list) or len(expect_mm) != 2
                                  or any(type(x) not in (int, float) or not math.isfinite(x) for x in expect_mm) or expect_mm[0] > expect_mm[1]):
        raise OnshapeError("expect_mm is [min, max] in mm.")
    a, b, both = values(single_a), values(single_b), values(pair)
    cylinders = ["diameter" in a, "diameter" in b]
    if kind == "cylinder" and not all(cylinders) or kind == "planar" and any(cylinders):
        raise OnshapeError(f"Measure sees cylinder faces {cylinders} for a and b, which does not match fit={kind!r}; check the face IDs.")
    gap = both.get("min dist", 0.0)
    out = {"fit": kind, "min_dist_mm": mm(gap), "max_dist_mm": mm(both["max dist"]) if "max dist" in both else None,
           "measured": {"a": a, "b": b, "pair": both}}
    if kind == "cylinder":
        bore, shaft = max(a["diameter"], b["diameter"]), min(a["diameter"], b["diameter"])
        out.update(bore_d_mm=mm(bore), shaft_d_mm=mm(shaft), diametral_clearance_mm=mm(bore - shaft),
                   min_radial_gap_mm=mm(gap), axis_offset_mm=None, checked="diametral_clearance_mm")
        if "parallel axis distance" in both:
            out["axis_offset_mm"] = mm(both["parallel axis distance"])  # measured by Onshape
        elif gap <= 0:
            out["note"] = "The cylinders touch or overlap: the axis offset is not derivable from Measure."
        else:
            # Shaft inside the bore, parallel axes: tightest gap = (bore - shaft)/2 - offset.
            out["axis_offset_mm"] = mm((bore - shaft) / 2 - gap)
            out["note"] = "Axis offset assumes parallel axes with the shaft inside the bore."
    else:
        out.update(gap_mm=mm(gap), checked="gap_mm", note="Gap assumes the faces are parallel and face each other.")
    if expect_mm is not None:
        out["in_range"] = expect_mm[0] <= out[out["checked"]] <= expect_mm[1]
    return out
