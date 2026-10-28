"""High-level, fully constrained sketches for feature(add): {"sketch": {...}} becomes a BTMSketch-151 feature.

Each item writes the constraints a careful user would draw by hand (centre on an anchor, size from an expression);
optional explicit constraints place items relative to each other or to existing geometry. The caller verifies the
result with Onshape's own solve status: the builder never claims a sketch is fully defined.
"""
from __future__ import annotations

import math

from .client import OnshapeError

PLANES = {"top": "Top", "front": "Front", "right": "Right"}
ORIGIN_QUERY = 'query=qCreatedBy(makeId("Origin"), EntityType.VERTEX);'
# Radial-line orientation for the first pattern hole; other angles need an angle dimension (not supported yet).
START_ANGLES = {"0 deg": "HORIZONTAL", "90 deg": "VERTICAL", "180 deg": "HORIZONTAL", "270 deg": "VERTICAL"}
ENUMS = {"direction": "DimensionDirection", "halfSpace0": "DimensionHalfSpace", "halfSpace1": "DimensionHalfSpace"}


def _string(pid, value):
    return {"btType": "BTMParameterString-149", "parameterId": pid, "value": value}


def _quantity(pid, expression):
    return {"btType": "BTMParameterQuantity-147", "parameterId": pid, "isInteger": False, "value": 0, "expression": expression}


def _query(pid, query):
    return {"btType": "BTMParameterQueryList-148", "parameterId": pid, "queries": [query]}


def _external(ref):
    """'origin', {"vertex": id} or {"edge": id} as a query; None for a local reference."""
    if ref == "origin":
        return {"btType": "BTMIndividualQuery-138", "queryStatement": None, "queryString": ORIGIN_QUERY}
    if isinstance(ref, dict) and set(ref) in ({"vertex"}, {"edge"}):
        return {"btType": "BTMIndividualQuery-138", "queryStatement": None, "deterministicIds": [next(iter(ref.values()))]}
    if isinstance(ref, dict):
        raise OnshapeError(f"Unknown reference {ref}; use 'origin', {{'vertex': id}}, {{'edge': id}} or a local name.")
    return None


class Builder:
    def __init__(self):
        self.entities, self.constraints, self.points, self.curves, self.count = [], [], set(), set(), 0

    def constraint(self, ctype, first, second=None, **quantities):
        """Two-reference constraint; an external reference must come second (Onshape's externalSecond slot)."""
        if _external(first) is not None:
            first, second = second, first
            if _external(first) is not None:
                raise OnshapeError(f"{ctype} needs at least one local sketch reference.")
        self.count += 1
        params = [_string("localFirst", self.local(first))]
        if second is not None:
            ext = _external(second)
            params.append(_query("externalSecond", ext) if ext else _string("localSecond", self.local(second)))
        for pid, value in quantities.items():
            if pid in ENUMS:  # a plain string here is ignored and the default (e.g. MINIMUM distance) applies
                params.append({"btType": "BTMParameterEnum-145", "parameterId": pid, "enumName": ENUMS[pid], "value": value})
            else:
                params.append(_quantity(pid, value))
        self.constraints.append({"btType": "BTMSketchConstraint-2", "constraintType": ctype, "entityId": f"k{self.count}", "parameters": params})

    def local(self, ref):
        if not isinstance(ref, str) or (ref not in self.points and ref not in self.curves):
            raise OnshapeError(f"Unknown sketch reference {ref!r}.")
        return ref

    def size(self, eid, item):
        if ("d" in item) == ("r" in item):
            raise OnshapeError("A circle needs exactly one of d (diameter) or r (radius).")
        dim = ("DIAMETER", item["d"]) if "d" in item else ("RADIUS", item["r"])
        self.constraint(dim[0], eid, length=dim[1], labelRatio="1.3", labelAngle="0.785*rad")

    def anchor(self, point, curve, at):
        """Tie a centre point to its anchor: concentric for a circle on a circular edge, otherwise coincident."""
        if at is None:
            return
        if isinstance(at, dict) and "edge" in at:
            if curve is None:
                raise OnshapeError("Only circles can be concentric with an edge; anchor other items on a point.")
            self.constraint("CONCENTRIC", curve, at)
        else:
            self.constraint("COINCIDENT", point, at if _external(at) is not None else self.alias(at))

    def alias(self, ref):
        return ref[:-len(".center")] + ".middle" if isinstance(ref, str) and ref.endswith(".center") and ref[:-7] + ".middle" in self.points else ref

    def circle(self, eid, r_mm, x_mm=0.0, y_mm=0.0, construction=False):
        self.entities.append({"btType": "BTMSketchCurve-4", "entityId": eid, "centerId": f"{eid}.center", "isConstruction": construction,
                              "geometry": {"btType": "BTCurveGeometryCircle-115", "radius": r_mm / 1000, "xCenter": x_mm / 1000,
                                           "yCenter": y_mm / 1000, "xDir": 1.0, "yDir": 0.0, "clockwise": False}})
        self.curves.add(eid)
        self.points.add(f"{eid}.center")

    def line(self, eid, a, b, construction=False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1.0
        self.entities.append({"btType": "BTMSketchCurveSegment-155", "entityId": eid, "startPointId": f"{eid}.start", "endPointId": f"{eid}.end",
                              "isConstruction": construction, "startParam": 0.0, "endParam": n / 1000,
                              "geometry": {"btType": "BTCurveGeometryLine-117", "pntX": a[0] / 1000, "pntY": a[1] / 1000, "dirX": dx / n, "dirY": dy / n}})
        self.curves.add(eid)
        self.points.update({f"{eid}.start", f"{eid}.end"})

    def point(self, eid, construction=True):
        self.entities.append({"btType": "BTMSketchPoint-158", "entityId": eid, "isConstruction": construction, "isUserPoint": True, "x": 0.0, "y": 0.0})
        self.points.add(eid)

    def add_circle(self, iid, item):
        self.circle(iid, 5.0, construction=item.get("construction", False))
        self.size(iid, item)
        self.anchor(f"{iid}.center", iid, item.get("at"))

    def add_pattern(self, iid, item):
        """Holes on a construction pitch circle: equal chords between neighbours, one radial line fixes the orientation."""
        n = item.get("count")
        if not isinstance(n, int) or n < 2:
            raise OnshapeError("A pattern needs count >= 2.")
        start = item.get("start_angle", "0 deg")
        if start not in START_ANGLES:
            raise OnshapeError("start_angle must be 0, 90, 180 or 270 deg for now.")
        a0 = float(start.split()[0])
        pts = [(10 * math.cos(math.radians(a0 + 360 * i / n)), 10 * math.sin(math.radians(a0 + 360 * i / n))) for i in range(n)]
        pcd = f"{iid}.pcd"
        self.circle(pcd, 10.0, construction=True)
        self.constraint("DIAMETER", pcd, length=item["pcd"], labelRatio="1.3", labelAngle="0.785*rad")
        self.anchor(f"{pcd}.center", pcd, item.get("at"))
        holes = [f"{iid}.h{i}" for i in range(n)]
        for i, (h, p) in enumerate(zip(holes, pts)):
            self.circle(h, 1.0, *p)
            if n > 2 or i == 0:  # with two holes the second one follows from the midpoint below
                self.constraint("COINCIDENT", f"{h}.center", pcd)
        self.size(holes[0], item)
        for h in holes[1:]:
            self.constraint("EQUAL", h, holes[0])
        if n == 2:  # two holes sit on a diameter: the pitch circle centre is midway between them
            self._midpoint(f"{pcd}.center", f"{holes[0]}.center", f"{holes[1]}.center")
        for i in range(n if n > 2 else 0):
            t = f"{iid}.t{i}"
            self.line(t, pts[i], pts[(i + 1) % n], construction=True)
            self.constraint("COINCIDENT", f"{t}.start", f"{holes[i]}.center")
            self.constraint("COINCIDENT", f"{t}.end", f"{holes[(i + 1) % n]}.center")
            if i:
                self.constraint("EQUAL", t, f"{iid}.t0")
        radial = f"{iid}.radial"
        self.line(radial, (0.0, 0.0), pts[0], construction=True)
        self.constraint("COINCIDENT", f"{radial}.start", f"{pcd}.center")
        self.constraint("COINCIDENT", f"{radial}.end", f"{holes[0]}.center")
        self.constraint(START_ANGLES[start], radial)

    def add_rectangle(self, iid, item):
        """Onshape's centre-point rectangle: four lines, a construction middle point on both diagonals, width and height."""
        w, h = 10.0, 6.0
        c = item.get("construction", False)
        corners = {"bl": (-w / 2, -h / 2), "br": (w / 2, -h / 2), "tr": (w / 2, h / 2), "tl": (-w / 2, h / 2)}
        sides = {"bottom": ("bl", "br"), "right": ("br", "tr"), "top": ("tr", "tl"), "left": ("tl", "bl")}
        for name, (a, b) in sides.items():
            self.line(f"{iid}.{name}", corners[a], corners[b], construction=c)
        order = list(sides)
        for i, name in enumerate(order):
            self.constraint("COINCIDENT", f"{iid}.{name}.end", f"{iid}.{order[(i + 1) % 4]}.start")
        self.constraint("HORIZONTAL", f"{iid}.bottom")
        self.constraint("PARALLEL", f"{iid}.top", f"{iid}.bottom")
        self.constraint("PERPENDICULAR", f"{iid}.left", f"{iid}.bottom")
        self.constraint("PARALLEL", f"{iid}.right", f"{iid}.left")
        mid = f"{iid}.middle"
        self.point(mid)
        self._midpoint(mid, f"{iid}.bottom.start", f"{iid}.top.start")  # bl and tr: one diagonal is enough in a rectangle
        self.constraint("DISTANCE", f"{iid}.left", f"{iid}.right", direction="MINIMUM", length=item["w"],
                        halfSpace0="LEFT", halfSpace1="RIGHT", labelRatio="0.5", labelDistance="0.005*m")
        self.constraint("DISTANCE", f"{iid}.bottom", f"{iid}.top", direction="MINIMUM", length=item["h"],
                        halfSpace0="LEFT", halfSpace1="RIGHT", labelRatio="0.5", labelDistance="0.005*m")
        self.anchor(mid, None, item.get("at"))

    def _midpoint(self, mid, a, b):
        self.count += 1
        self.constraints.append({"btType": "BTMSketchConstraint-2", "constraintType": "MIDPOINT", "entityId": f"k{self.count}",
                                 "parameters": [_string("localMidpoint", mid), _string("localEntity1", a), _string("localEntity2", b)]})

    def add_point(self, iid, item):
        self.point(iid, construction=item.get("construction", True))
        self.anchor(iid, None, item.get("at"))

    def explicit(self, spec):
        """{"kind": [a, b, (expression)]} for the constraint kinds a user draws by hand."""
        (kind, args), = spec.items()
        args = [self.alias(a) for a in args]
        direction = {"horizontal_distance": "HORIZONTAL", "vertical_distance": "VERTICAL", "distance": "MINIMUM"}
        if kind in direction:
            a, b, length = args
            self.constraint("DISTANCE", a, b, direction=direction[kind], length=length, labelRatio="0.5", labelDistance="0.005*m")
        elif kind in ("coincident", "concentric", "equal", "parallel", "perpendicular", "tangent"):
            self.constraint(kind.upper(), *args)
        elif kind in ("horizontal", "vertical"):
            self.constraint(kind.upper(), *args)
        elif kind in ("diameter", "radius"):
            a, length = args
            self.constraint(kind.upper(), a, length=length, labelRatio="1.3", labelAngle="0.785*rad")
        else:
            raise OnshapeError(f"Unsupported constraint {kind!r}.")


def build(spec):
    """Return a newSketch feature definition for a {"name", "plane", "items", "constraints"} description."""
    if not isinstance(spec, dict) or not spec.get("name") or not spec.get("items"):
        raise OnshapeError("A sketch needs a name and at least one item.")
    plane = spec.get("plane", "Top")
    if isinstance(plane, str) and plane.lower() in PLANES:
        plane_query = {"btType": "BTMIndividualQuery-138", "queryStatement": None,
                       "queryString": f'query=qCreatedBy(makeId("{PLANES[plane.lower()]}"), EntityType.FACE);'}
    elif isinstance(plane, dict) and set(plane) == {"face"}:
        plane_query = {"btType": "BTMIndividualQuery-138", "queryStatement": None, "deterministicIds": [plane["face"]]}
    else:
        raise OnshapeError("plane must be Top, Front, Right or {'face': deterministic id}.")
    b = Builder()
    kinds = {"circle": b.add_circle, "pattern": b.add_pattern, "rectangle": b.add_rectangle, "point": b.add_point}
    for n, item in enumerate(spec["items"]):
        (kind, body), = ((k, v) for k, v in item.items() if k != "id")
        if kind not in kinds:
            raise OnshapeError(f"Unsupported sketch item {kind!r}; use circle, pattern, rectangle or point.")
        iid = item.get("id") or f"{kind[0]}{n}"
        if "." in iid or iid in b.curves or iid in b.points:
            raise OnshapeError(f"Item id {iid!r} must be unique and contain no dot.")
        kinds[kind](iid, body)
    for c in spec.get("constraints", []):
        b.explicit(c)
    return {"btType": "BTMSketch-151", "featureType": "newSketch", "name": spec["name"], "suppressed": False,
            "parameters": [_query("sketchPlane", plane_query)], "entities": b.entities, "constraints": b.constraints}
