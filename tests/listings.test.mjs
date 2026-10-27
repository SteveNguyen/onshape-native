import test from "node:test";
import assert from "node:assert/strict";
import {tabsFromContents, branchNames} from "../extension/listings.js";

const A = "a".repeat(24), B = "b".repeat(24), C = "c".repeat(24), D = "d".repeat(24);
const contents = {
  elements: [{id: A, name: "Body", elementType: "PARTSTUDIO"}, {id: B, name: "Asm", elementType: "ASSEMBLY"},
             {id: C, name: "Loose", elementType: "BLOB"}],
  folders: {nodeId: "r", groupName: "", groups: [
    {nodeId: "n1", elementId: A},
    {nodeId: "f1", groupName: "Gripper", groups: [{nodeId: "f2", groupName: "Fingers", groups: [{nodeId: "n2", elementId: B}]}]},
    {nodeId: "n3", elementId: D}]},  // D is not an available element
};

test("tabs follow the tree, with folder paths; unplaced elements are appended", () => {
  assert.deepEqual(tabsFromContents(contents), [
    {eid: A, name: "Body", type: "PARTSTUDIO"},
    {eid: B, name: "Asm", type: "ASSEMBLY", folder: "Gripper / Fingers"},
    {eid: C, name: "Loose", type: "BLOB"}]);
});

test("missing or malformed listings give no tabs", () => {
  assert.deepEqual(tabsFromContents(undefined), []);
  assert.deepEqual(tabsFromContents({elements: "x", folders: 3}), []);
});

test("branch names are keyed by lower-cased id and bounded", () => {
  assert.deepEqual(branchNames([{id: A.toUpperCase(), name: " main "}, {id: 5}, null]), {[A]: "main"});
  assert.equal(branchNames([{id: A, name: "x".repeat(500)}])[A].length, 120);
  assert.deepEqual(branchNames({}), {});
});
