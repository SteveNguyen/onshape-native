import pytest

from onshape_native.client import OnshapeError
from onshape_native.sketch_builder import build

# Degrees of freedom per sketch entity and removed per constraint; a point-on-curve COINCIDENT removes 1.
ENTITY_DOF = {"BTMSketchCurve-4": 3, "BTMSketchCurveSegment-155": 4, "BTMSketchPoint-158": 2}
CONSTRAINT_DOF = {"COINCIDENT": 2, "CONCENTRIC": 2, "MIDPOINT": 2, "DIAMETER": 1, "RADIUS": 1, "EQUAL": 1, "HORIZONTAL": 1,
                  "VERTICAL": 1, "PARALLEL": 1, "PERPENDICULAR": 1, "DISTANCE": 1}


def free_dof(feature):
    """Entity DOF minus constraint DOF (no redundancy analysis): 0 for every item the builder anchors."""
    curves = {e["entityId"] for e in feature["entities"] if e["btType"] != "BTMSketchPoint-158"}
    removed = 0
    for c in feature["constraints"]:
        n = CONSTRAINT_DOF[c["constraintType"]]
        second = next((p.get("value") for p in c["parameters"] if p["parameterId"] == "localSecond"), None)
        if c["constraintType"] == "COINCIDENT" and second in curves:
            n = 1
        removed += n
    return sum(ENTITY_DOF[e["btType"]] for e in feature["entities"]) - removed


def params(constraint):
    return {p["parameterId"]: p for p in constraint["parameters"]}


@pytest.mark.parametrize("item", [
    {"circle": {"d": "10 mm", "at": "origin"}},
    {"circle": {"r": "#hole_r", "at": {"vertex": "JHK"}}},
    {"circle": {"d": "14 mm", "at": {"edge": "JGB"}}},
    {"pattern": {"count": 4, "pcd": "30 mm", "d": "3 mm", "start_angle": "90 deg", "at": "origin"}},
    {"pattern": {"count": 3, "pcd": "#pcd", "r": "1.2 mm", "start_angle": "90 deg", "at": "origin"}},
    {"pattern": {"count": 2, "pcd": "20 mm", "d": "2 mm", "at": "origin"}},
    {"rectangle": {"w": "20 mm", "h": "8 mm", "at": "origin"}},
])
def test_each_anchored_item_has_no_free_degrees_of_freedom(item):
    assert free_dof(build({"name": "s", "plane": "Top", "items": [item]})) == 0


def test_unanchored_item_is_left_free_for_the_solver_to_report():
    assert free_dof(build({"name": "s", "items": [{"circle": {"d": "3 mm"}}]})) == 2


def test_explicit_distances_fix_an_unanchored_circle_with_enum_directions():
    f = build({"name": "s", "items": [{"id": "h1", "circle": {"d": "3 mm"}}],
               "constraints": [{"horizontal_distance": ["h1.center", "origin", "12 mm"]},
                               {"vertical_distance": ["origin", "h1.center", "5 mm"]}]})
    assert free_dof(f) == 0
    distances = [params(c) for c in f["constraints"] if c["constraintType"] == "DISTANCE"]
    # A string direction is silently ignored by Onshape (default MINIMUM): it must be the DimensionDirection enum.
    assert [(d["direction"]["btType"], d["direction"]["enumName"], d["direction"]["value"]) for d in distances] == [
        ("BTMParameterEnum-145", "DimensionDirection", "HORIZONTAL"), ("BTMParameterEnum-145", "DimensionDirection", "VERTICAL")]
    # The origin goes into Onshape's only external slot even when given first.
    assert all(d["localFirst"]["value"] == "h1.center" and "externalSecond" in d for d in distances)
    assert distances[0]["length"]["expression"] == "12 mm"


def test_sizes_and_anchors_use_the_users_expressions_and_references():
    f = build({"name": "horn", "plane": "Right", "items": [{"id": "c", "circle": {"d": "#m2_clear_d + 2*#fit_clr", "at": {"edge": "JGB"}}}]})
    assert f["featureType"] == "newSketch" and f["name"] == "horn"
    assert 'makeId("Right")' in f["parameters"][0]["queries"][0]["queryString"]
    kinds = {c["constraintType"]: params(c) for c in f["constraints"]}
    assert kinds["DIAMETER"]["length"]["expression"] == "#m2_clear_d + 2*#fit_clr"
    assert kinds["CONCENTRIC"]["externalSecond"]["queries"][0]["deterministicIds"] == ["JGB"]


def test_rectangle_centre_is_addressable_as_center():
    f = build({"name": "s", "items": [{"id": "r", "rectangle": {"w": "4 mm", "h": "2 mm"}}, {"id": "c", "circle": {"d": "1 mm", "at": "r.center"}}]})
    anchor = [params(c) for c in f["constraints"] if c["constraintType"] == "COINCIDENT" and params(c)["localFirst"]["value"] == "c.center"]
    assert anchor[0]["localSecond"]["value"] == "r.middle"


@pytest.mark.parametrize("spec, message", [
    ({"name": "s", "items": []}, "at least one item"),
    ({"name": "s", "plane": "Side", "items": [{"circle": {"d": "1 mm"}}]}, "plane must be"),
    ({"name": "s", "items": [{"circle": {"d": "1 mm", "r": "1 mm"}}]}, "exactly one of d"),
    ({"name": "s", "items": [{"slot": {}}]}, "Unsupported sketch item"),
    ({"name": "s", "items": [{"pattern": {"count": 3, "pcd": "1 mm", "d": "1 mm", "start_angle": "45 deg"}}]}, "start_angle"),
    ({"name": "s", "items": [{"rectangle": {"w": "1 mm", "h": "1 mm", "at": {"edge": "JGB"}}}]}, "Only circles"),
    ({"name": "s", "items": [{"id": "a", "circle": {"d": "1 mm"}}], "constraints": [{"coincident": ["a.center", "nope"]}]}, "Unknown sketch reference"),
    ({"name": "s", "items": [{"id": "a", "circle": {"d": "1 mm"}}, {"id": "a", "circle": {"d": "1 mm"}}]}, "must be unique"),
])
def test_invalid_descriptions_are_refused_before_any_write(spec, message):
    with pytest.raises(OnshapeError, match=message):
        build(spec)
