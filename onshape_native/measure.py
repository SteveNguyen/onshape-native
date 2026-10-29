"""Onshape's own Measure tool (the editor's ui.GBTUiMeasureCall) applied to one named fit.

Observed replies (2026-10-29): one cylinder gives Diameter/Radius/Area; two entities give Min dist, Max dist, Angle and
Area. Values are metres. Angles are taken as radians, like every other angle in the editor's messages (only 0 was
observed). Closest points come back as zeros, so none are reported.
"""
from __future__ import annotations

import math
import re
import secrets

from .client import OnshapeError

COMMAND = "ui.GBTUiMeasureCall"
FACE_ID = re.compile(r"[A-Za-z0-9_.+/=-]{1,64}")
OCCURRENCE_ID = re.compile(r"[A-Za-z0-9+/=]{1,64}")
PARALLEL = 1e-4  # rad (~0.006 deg): axes or faces this close to parallel count as parallel
# The editor's measurement types (GBTMeasurementType); labels like "Min dist:" are translated, these are not.
TYPES = {0: "center position", 1: "position", 2: "center distance", 3: "max dist", 4: "min dist", 5: "perpendicular distance",
         6: "axis perpendicular distance", 7: "parallel axis distance", 8: "parallel distance", 9: "center axis distance",
         10: "length", 11: "diameter", 12: "radius", 13: "max radius", 14: "min radius", 15: "angle", 19: "area"}

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
    """{'min dist': metres, 'diameter': metres, 'angle': radians, ...} from one Measure reply."""
    if reply.get("error"):
        raise OnshapeError(f"Onshape Measure refused the selection (error {reply['error']}); check the face IDs and occurrence paths.")
    return {TYPES.get(m.get("measurementType"), f"type {m.get('measurementType')}"): m["value"]
            for m in reply.get("measurements", []) if "value" in m}


def fit(single_a, single_b, pair, expect_mm=None):
    """Fit numbers from Measure on entity a alone, b alone, and both. Cylinder pairs give the diametral clearance;
    parallel pairs give the gap. expect_mm = [min, max] checks that number."""
    if expect_mm is not None and (not isinstance(expect_mm, list) or len(expect_mm) != 2
                                  or any(type(x) not in (int, float) or not math.isfinite(x) for x in expect_mm) or expect_mm[0] > expect_mm[1]):
        raise OnshapeError("expect_mm is [min, max] in mm.")
    a, b, both = values(single_a), values(single_b), values(pair)
    out = {"min_dist_mm": mm(both.get("min dist", 0.0)), "max_dist_mm": mm(both["max dist"]) if "max dist" in both else None,
           "angle_deg": round(math.degrees(both["angle"]), 6) if "angle" in both else None,
           "measured": {"a": a, "b": b, "pair": both}}
    parallel = "angle" in both and abs(both["angle"]) < PARALLEL
    if "diameter" in a and "diameter" in b:
        bore, shaft = max(a["diameter"], b["diameter"]), min(a["diameter"], b["diameter"])
        out.update(kind="cylindrical", bore_d_mm=mm(bore), shaft_d_mm=mm(shaft), diametral_clearance_mm=mm(bore - shaft),
                   min_radial_gap_mm=out["min_dist_mm"], axis_offset_mm=None, checked="diametral_clearance_mm")
        if not parallel:
            out["note"] = "Axes are not parallel: the axis offset is not derived."
        elif "parallel axis distance" in both:
            out["axis_offset_mm"] = mm(both["parallel axis distance"])  # measured by Onshape
        elif both.get("min dist", 0.0) <= 0:
            out["note"] = "The cylinders touch or overlap: the axis offset is not derivable from Measure."
        else:
            # Shaft inside the bore with parallel axes: tightest gap = (bore - shaft)/2 - offset.
            out["axis_offset_mm"] = mm((bore - shaft) / 2 - both["min dist"])
            out["note"] = "Axis offset assumes the shaft sits inside the bore."
    elif parallel:
        out.update(kind="parallel", gap_mm=out["min_dist_mm"], checked="gap_mm")
    else:
        out["kind"] = "general"
    if expect_mm is not None and "checked" in out:
        out["in_range"] = expect_mm[0] <= out[out["checked"]] <= expect_mm[1]
    elif expect_mm is not None:
        out["note"] = "expect_mm applies to cylinder pairs (diametral clearance) or parallel faces (gap)."
    return out
