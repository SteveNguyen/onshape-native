"""Kernel-side measurements: geometry, not pixels, is the source of truth."""
import math
import re

SUMMARY_SCRIPT = '''function(context is Context, queries) {
    const bodies = evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID));
    var rows = [];
    for (var body in bodies) {
        const bounds = evBox3d(context, { "topology" : body, "tight" : true });
        rows = append(rows, {
            "id" : transientQueriesToStrings([body])[0],
            "min_mm" : bounds.minCorner / millimeter,
            "max_mm" : bounds.maxCorner / millimeter,
            "size_mm" : (bounds.maxCorner - bounds.minCorner) / millimeter,
            "volume_mm3" : evVolume(context, { "entities" : body }) / (millimeter^3),
            "faces" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.FACE))),
            "edges" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.EDGE)))
        });
    }
    return rows;
}'''


def decode_fs(value):
    """Decode typed FeatureScript values; unknown representations remain explicit."""
    if isinstance(value, list):
        return [decode_fs(x) for x in value]
    if not isinstance(value, dict):
        return value
    msg = value.get("message", value)
    typ = str(value.get("typeName", value.get("btType", "")))
    if "FSValueMap" in typ:
        out = {}
        for pair in msg.get("value", []):
            pair = pair.get("message", pair)
            out[str(decode_fs(pair["key"]))] = decode_fs(pair["value"])
        return out
    if any(t in typ for t in ("FSValueArray", "FSValueVector")):
        return [decode_fs(x) for x in msg.get("value", [])]
    if any(t in typ for t in ("FSValueString", "FSValueNumber", "FSValueBoolean")):
        if msg.get("unitToPower"):
            return {"value": msg.get("value"), "units": msg["unitToPower"]}
        return msg.get("value")
    return {k: decode_fs(v) for k, v in value.items()}


def feature_rows(raw):
    states = raw.get("featureStates", {})
    return [{"id": f.get("featureId"), "name": f.get("name"), "type": f.get("featureType"),
             "suppressed": f.get("suppressed", False),
             "status": states.get(f.get("featureId"), {}).get("featureStatus", "UNKNOWN"),
             "parameters": {p["parameterId"]: p.get("expression", p.get("value"))
                            for p in f.get("parameters", [])
                            if "parameterId" in p and ("expression" in p or "value" in p)}}
            for f in raw.get("features", [])]


def delta(before, after):
    out = {}
    for field in ("features", "solids"):
        a = {v["id"]: v for v in before.get(field, [])}
        b = {v["id"]: v for v in after.get(field, [])}
        out[field] = {"added": [b[k] for k in b.keys() - a.keys()],
                      "removed": sorted(a.keys() - b.keys()),
                      "changed": [b[k] for k in b.keys() & a.keys() if a[k] != b[k]]}
    return out


def measurement_script(expression, metrics, other=""):
    """Small caller inputs expand into one deterministic kernel-side batch."""
    from .client import OnshapeError
    if not expression or not metrics or len(metrics) > 8:
        raise OnshapeError("Supply a Query expression and 1-8 metrics.")
    statements = ['const q = (' + expression + ');', 'const count = size(evaluateQuery(context, q));',
                  'var result = { "count" : count };', 'if (count == 0) return result;']
    definitions = {
        "bounds": 'const b = evBox3d(context, {"topology":q,"tight":true}); result.bounds_mm = {"min":b.minCorner/millimeter,"max":b.maxCorner/millimeter,"size":(b.maxCorner-b.minCorner)/millimeter};',
        "volume": 'result.volume_mm3 = evVolume(context, {"entities":q})/(millimeter^3);',
        "area": 'result.area_mm2 = evArea(context, {"entities":q})/(millimeter^2);',
        "length": 'result.length_mm = evLength(context, {"entities":q})/millimeter;',
        "plane": 'if (count == 1) { const p = evPlane(context, {"face":q}); result.plane = {"origin_mm":p.origin/millimeter,"normal":p.normal,"x":p.x}; } else result.plane_error = "Expected exactly one face";',
        "distance": 'const other = (' + (other or 'qNothing()') + '); result.other_count = size(evaluateQuery(context, other)); if (result.other_count > 0) result.distance_mm = evDistance(context, {"side0":q,"side1":other}).distance/millimeter;',
    }
    for metric in dict.fromkeys(metrics):
        if metric not in definitions:
            raise OnshapeError("Metrics: bounds, volume, area, length, plane, distance.")
        if metric == "distance" and not other:
            raise OnshapeError("distance requires other_expression.")
        statements.append(definitions[metric])
    return 'function(context is Context, queries) { ' + ' '.join(statements) + ' return result; }'


def topology_script(expression, offset=0, limit=20):
    from .client import OnshapeError
    if not expression or offset < 0 or not 1 <= limit <= 50:
        raise OnshapeError("topology requires a face Query, offset >= 0, and limit 1-50.")
    # Solid-body faces only: datum planes and sketch regions are faces too.
    return '''function(context is Context, queries) {
      const faces = evaluateQuery(context, qIntersection([qEntityFilter((''' + expression + '''), EntityType.FACE),
          qOwnedByBody(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), EntityType.FACE)]));
      var rows = [];
      for (var i = ''' + str(offset) + '''; i < min(size(faces), ''' + str(offset + limit) + '''); i += 1) {
        const face = faces[i];
        const surface = evSurfaceDefinition(context, {"face":face,"returnBSplinesAsOther":true});
        var row = {"id":transientQueriesToStrings([face])[0],
                   "area_mm2":evArea(context,{"entities":face})/(millimeter^2),
                   "adjacent_faces":transientQueriesToStrings(evaluateQuery(context,qAdjacent(face,AdjacencyType.EDGE,EntityType.FACE)))};
        if (surface is Plane) {
          row["type"] = "plane";
          row.origin_mm = surface.origin/millimeter;
          row.normal = surface.normal;
        } else if (surface is Cylinder) {
          row["type"] = "cylinder";
          row.radius_mm = surface.radius/millimeter;
          row.axis_origin_mm = surface.coordSystem.origin/millimeter;
          row.axis = surface.coordSystem.zAxis;
        } else if (surface is Sphere) {
          row["type"] = "sphere";
          row.radius_mm = surface.radius/millimeter;
          row.center_mm = surface.center/millimeter;
        } else {
          row["type"] = "other";
        }
        rows = append(rows,row);
      }
      return {"count":size(faces),"offset":''' + str(offset) + ''',"rows":rows};
    }'''


def unit(vector, what):
    from .client import OnshapeError
    if not isinstance(vector, (list, tuple)) or len(vector) != 3 or any(type(x) not in (int, float) or not math.isfinite(x) for x in vector):
        raise OnshapeError(what + " must be three finite numbers.")
    norm = math.sqrt(sum(x * x for x in vector))
    if norm < 1e-9:
        raise OnshapeError(what + " must be nonzero.")
    return [x / norm for x in vector]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def view_basis(back, up=None):
    """Right-handed (right, up, back) unit axes for a viewer on the +back side.
    Default up is world Z, or ±Y when looking along Z: the frames of Onshape's
    standard views (front XZ, top XY, bottom XYback, isometric). Section-plane
    u/v axes use the same rule, so a section image and its numbers agree."""
    from .client import OnshapeError
    back = unit(back, "direction")
    if up is None:
        up = [0, 0, 1] if abs(back[2]) < 0.999 else [0, 1 if back[2] > 0 else -1, 0]
    right = cross(unit(up, "up"), back)
    if math.sqrt(dot(right, right)) < 1e-6:
        raise OnshapeError("up must not be parallel to the view direction.")
    right = unit(right, "right")
    return right, cross(back, right), back


def view_matrix(direction, up=None, center=(0, 0, 0)):
    """shadedviews viewMatrix (3 rows x 4 columns, applied to the model): rows are the
    view's right/up/toward-viewer axes in model coordinates; the last column (meters)
    moves `center` to the view origin. direction points from the model to the viewer."""
    return [x for row in view_basis(direction, up) for x in (*row, -dot(row, center))]


FACE_ID = re.compile(r"[A-Za-z0-9]{1,32}")


def face_query(face):
    """A bare transient face ID goes through evalFeatureScript `queries`; anything else is a Query expression."""
    from .client import OnshapeError
    if not isinstance(face, str) or not face.strip():
        raise OnshapeError("face must be a FeatureScript Query expression or a face ID.")
    return ("queries.face", {"face": [face]}) if FACE_ID.fullmatch(face) else (face, {})


def face_plane(expression):
    """FeatureScript statements defining `face` and `tangent`: the tangent plane at the
    face point nearest its centroid (outward normal for solid faces)."""
    return ('const face = qEntityFilter((' + expression + '), EntityType.FACE);'
            ' const faceCount = size(evaluateQuery(context, face));'
            ' if (faceCount != 1) return {"count" : faceCount, "error" : "The plane face must resolve to exactly one face"};'
            ' const tangent = evFaceTangentPlane(context, {"face" : face, "parameter" : evDistance(context,'
            ' {"side0" : face, "side1" : evApproximateCentroid(context, {"entities" : face})}).sides[0].parameter});')


def face_plane_script(expression):
    return ('function(context is Context, queries) { ' + face_plane(expression) +
            ' const bounds = evBox3d(context, {"topology" : face, "tight" : true});'
            ' return {"count" : 1, "origin" : tangent.origin / meter, "normal" : tangent.normal, "x" : tangent.x,'
            ' "min" : bounds.minCorner / meter, "max" : bounds.maxCorner / meter}; }')


def section_script(face=None, plane=None, offset=0, limit=20):
    """Exact planar section of solid bodies in evalFeatureScript's temporary context: an
    infinite split plane, then one of each pair of coincident cut faces (the one whose
    outward normal follows the plane normal). Nothing is written to the model."""
    from .client import OnshapeError
    if (face is None) == (plane is None) or offset < 0 or not 1 <= limit <= 50:
        raise OnshapeError("section requires a face expression or plane {origin_mm, normal}, offset >= 0, and limit 1-50.")
    if face is not None:
        setup = face_plane(face) + ' const origin = tangent.origin; const n = tangent.normal;'
    else:
        if not isinstance(plane, dict) or set(plane) != {"origin_mm", "normal"}:
            raise OnshapeError("plane must be {origin_mm:[x,y,z], normal:[x,y,z]}.")
        origin = plane["origin_mm"]
        if not isinstance(origin, list) or len(origin) != 3 or any(type(x) not in (int, float) or not math.isfinite(x) for x in origin):
            raise OnshapeError("origin_mm must be three finite numbers.")
        vec = lambda v: 'vector(' + ', '.join(repr(float(x)) for x in v) + ')'
        setup = 'const origin = ' + vec(origin) + ' * millimeter; const n = ' + vec(unit(plane["normal"], "normal")) + ';'
    end = str(offset + limit)
    return '''function(context is Context, queries) {
      ''' + setup + '''
      var up = vector(0, 0, 1);
      if (abs(n[2]) > 0.999) { up = vector(0, n[2] > 0 ? 1 : -1, 0); }
      const u = normalize(cross(up, n));
      const v = cross(n, u);
      const planeId = makeId("onshapeNativeSectionPlane");
      const splitId = makeId("onshapeNativeSectionSplit");
      opPlane(context, planeId, {"plane" : plane(origin, n, u)});
      var splitOk = false;
      try silent { opSplitPart(context, splitId, {"targets" : qAllModifiableSolidBodies(), "tool" : qCreatedBy(planeId, EntityType.FACE)}); splitOk = true; }
      var faces = [];
      for (var f in evaluateQuery(context, qCreatedBy(splitId, EntityType.FACE))) {
        if (dot(evPlane(context, {"face" : f}).normal, n) > 0) { faces = append(faces, f); }
      }
      var rows = [];
      for (var i = ''' + str(offset) + '''; i < min(size(faces), ''' + end + '''); i += 1) {
        const f = faces[i];
        const c = evApproximateCentroid(context, {"entities" : f});
        const bounds = evBox3d(context, {"topology" : f, "cSys" : coordSystem(origin, u, n), "tight" : true});
        var edges = [];
        for (var e in evaluateQuery(context, qAdjacent(f, AdjacencyType.EDGE, EntityType.EDGE))) {
          const count = (evCurveDefinition(context, {"edge" : e}) is Line) ? 2 : 12;
          var parameters = [];
          for (var k = 0; k < count; k += 1) { parameters = append(parameters, k / (count - 1)); }
          var points = [];
          for (var line in evEdgeTangentLines(context, {"edge" : e, "parameters" : parameters})) {
            points = append(points, [dot(line.origin - origin, u) / millimeter, dot(line.origin - origin, v) / millimeter]);
          }
          edges = append(edges, points);
        }
        rows = append(rows, {"area_mm2" : evArea(context, {"entities" : f}) / (millimeter ^ 2), "centroid_mm" : c / millimeter,
          "centroid_uv_mm" : [dot(c - origin, u) / millimeter, dot(c - origin, v) / millimeter],
          "extents_uv_mm" : {"min" : [bounds.minCorner[0] / millimeter, bounds.minCorner[1] / millimeter], "max" : [bounds.maxCorner[0] / millimeter, bounds.maxCorner[1] / millimeter]},
          "edges_uv_mm" : edges});
      }
      return {"split_ok" : splitOk, "count" : size(faces), "offset" : ''' + str(offset) + ''', "rows" : rows,
              "plane" : {"origin_mm" : origin / millimeter, "normal" : n, "u" : u, "v" : v}};
    }'''
