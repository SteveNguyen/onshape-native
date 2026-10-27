import test from "node:test";
import assert from "node:assert/strict";
import {ACTIONS, checkPolicy, effectivePolicy, tabMode, anyBranchMode, branchMode, hasAnyGrant, actionOn} from "../extension/grants.js";

const D = "a".repeat(24), W = "b".repeat(24), W2 = "c".repeat(24), E = "d".repeat(24), E2 = "e".repeat(24);
const doc = (branches = {}, actions = {}) => ({added: 1, source: "user", actions, branches});
const pol = docs => ({version: 2, docs});

test("ACTIONS lists the document actions", () => {
  assert.deepEqual(ACTIONS, ["versions", "branches", "merge", "tabs", "admin"]);
});

test("checkPolicy: undefined is an empty v2 policy", () => {
  assert.deepEqual(checkPolicy(undefined), {version: 2, docs: {}, allow_untested_native: false, allow_ui_fallback: false});
});

test("checkPolicy: v1 policy is stale and grants nothing", () => {
  const p = checkPolicy({docs: {[D]: {admin: true}}, allow_ui_fallback: true});
  assert.equal(p.stale, true);
  assert.deepEqual(p.docs, {});
  assert.equal(p.allow_ui_fallback, false);
});

test("checkPolicy: valid v2 is normalized (ids lower-cased, actions filled)", () => {
  const p = checkPolicy(pol({[D.toUpperCase()]: doc({[W.toUpperCase()]: {tabs: {[E.toUpperCase()]: {mode: "read"}}}})}));
  assert.equal(tabMode(p, D, W, E), "read");
  assert.equal(actionOn(p, D, "versions"), false);
  assert.equal(p.stale, undefined);
});

test("checkPolicy: malformed v2 throws", () => {
  const bad = [
    null, "x", pol(null), pol({nothex: doc()}), pol({[D]: null}),
    pol({[D]: doc({nothex: {tabs: {}}})}),
    pol({[D]: doc({[W]: {tabs: {nothex: {mode: "read"}}}})}),
    pol({[D]: doc({[W]: {tabs: {[E]: {mode: "admin"}}}})}),
    pol({[D]: doc({[W]: {tabs: {[E]: {}}}})}),
    pol({[D]: doc({[W]: {all: "rw", tabs: {}}})}),
    pol({[D]: doc({}, {merge: "yes"})}),
    pol({[D]: {...doc(), name: 5}}),
  ];
  for (const p of bad) assert.throws(() => checkPolicy(p), /malformed.*popup/, JSON.stringify(p));
});

test("tabMode: tab grant, other tab/branch denied", () => {
  const p = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "write"}}}})});
  assert.equal(tabMode(p, D, W, E), "write");
  assert.equal(tabMode(p, D, W, E2), null);
  assert.equal(tabMode(p, D, W2, E), null);
  assert.equal(tabMode(p, "f".repeat(24), W, E), null);
});

test("tabMode: branch-wide all and '*' wildcard cover any tab", () => {
  // "*" only exists on worker-created docs
  const p = effectivePolicy(undefined, {docs: {[D]: {source: "created", added: 1, actions: {}, branches: {[W]: {all: "read", tabs: {}}, "*": {all: "write", tabs: {}}}}}});
  assert.equal(tabMode(p, D, W, E), "write");  // "*" beats the branch's read
  assert.equal(tabMode(p, D, W2, E2), "write");
  const q = pol({[D]: doc({[W]: {all: "read", tabs: {}}})});
  assert.equal(tabMode(q, D, W, E2), "read");
  assert.equal(tabMode(q, D, W2, E2), null);
});

test("tabMode: write beats read", () => {
  const p = pol({[D]: doc({[W]: {all: "read", tabs: {[E]: {mode: "write"}}}})});
  assert.equal(tabMode(p, D, W, E), "write");
  assert.equal(tabMode(p, D, W, E2), "read");
});

test("branchMode: whole-branch only, ignores single-tab grants", () => {
  const p = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "write"}}}, [W2]: {all: "write", tabs: {}}})});
  assert.equal(branchMode(p, D, W), null);
  assert.equal(branchMode(p, D, W2), "write");
});

test("anyBranchMode: max over all branches", () => {
  const p = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}, [W2]: {tabs: {[E]: {mode: "write"}}}})});
  assert.equal(anyBranchMode(p, D, E), "write");
  assert.equal(anyBranchMode(p, D, E2), null);
  const q = pol({[D]: doc({[W]: {all: "read", tabs: {}}})});
  assert.equal(anyBranchMode(q, D, E2), "read");
});

test("hasAnyGrant / actionOn", () => {
  const p = pol({[D]: doc({[W]: {tabs: {}}}, {merge: true})});
  assert.equal(hasAnyGrant(p, D), false);
  assert.equal(actionOn(p, D, "merge"), true);
  assert.equal(actionOn(p, D, "admin"), false);
  assert.equal(actionOn(p, "f".repeat(24), "merge"), false);
  assert.equal(hasAnyGrant(pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}})}), D), true);
  assert.equal(hasAnyGrant(pol({[D]: doc({[W]: {all: "read", tabs: {}}})}), D), true);
});

test("effectivePolicy: created doc is added", () => {
  const created = {docs: {[D]: {source: "created", added: 1, actions: {versions: true, merge: true}, branches: {"*": {all: "write", tabs: {}}}}}, grants: {}};
  const p = effectivePolicy(undefined, created);
  assert.equal(tabMode(p, D, W, E), "write");
  assert.equal(actionOn(p, D, "merge"), true);
  assert.equal(actionOn(p, D, "admin"), false);
});

test("effectivePolicy: created grant adds a tab, popup actions untouched, no mutation", () => {
  const base = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}}, {versions: true})});
  const snapshot = structuredClone(base);
  const created = {docs: {}, grants: {[D]: {branches: {[W]: {tabs: {[E2]: {mode: "write"}, [E]: {mode: "write"}}}}}}};
  const p = effectivePolicy(base, created);
  assert.equal(tabMode(p, D, W, E2), "write");
  assert.equal(tabMode(p, D, W, E), "write");  // unioned to the max mode
  assert.equal(actionOn(p, D, "versions"), true);
  assert.equal(actionOn(p, D, "merge"), false);
  assert.deepEqual(base, snapshot);
});

test("effectivePolicy: popup actions win over a created entry for the same doc", () => {
  const base = pol({[D]: doc({}, {merge: false})});
  const created = {docs: {[D]: {source: "created", added: 1, actions: {merge: true}, branches: {}}}, grants: {}};
  assert.equal(actionOn(effectivePolicy(base, created), D, "merge"), false);
});

test("effectivePolicy: old flat v1 created map is ignored", () => {
  const p = effectivePolicy(undefined, {[D]: {admin: false, source: "created", added: 1}});
  assert.deepEqual(p.docs, {});
  assert.equal(hasAnyGrant(p, D), false);
});

test("effectivePolicy: malformed created throws", () => {
  assert.throws(() => effectivePolicy(undefined, {docs: {nothex: {}}}), /malformed.*popup/);
  assert.throws(() => effectivePolicy(undefined, "x"), /malformed.*popup/);
});

test("effectivePolicy: created grants on an unknown doc are ignored", () => {
  const p = effectivePolicy(undefined, {docs: {}, grants: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "write"}}}}}}});
  assert.equal(hasAnyGrant(p, D), false);
  assert.deepEqual(p.docs, {});
});

test("effectivePolicy: created grants never copy actions", () => {
  const base = pol({[D]: doc({})});
  const p = effectivePolicy(base, {docs: {}, grants: {[D]: {actions: {admin: true, merge: true}, branches: {[W]: {tabs: {[E]: {mode: "read"}}}}}}});
  assert.equal(actionOn(p, D, "admin"), false);
  assert.equal(actionOn(p, D, "merge"), false);
  assert.equal(tabMode(p, D, W, E), "read");
});

test("effectivePolicy: created grants may add `all` on a concrete branch", () => {
  const p = effectivePolicy(pol({[D]: doc({})}), {grants: {[D]: {branches: {[W]: {all: "write", tabs: {}}}}}});
  assert.equal(branchMode(p, D, W), "write");
});

test('"*" is only accepted in created.docs', () => {
  const star = {"*": {all: "write", tabs: {}}};
  assert.throws(() => checkPolicy(pol({[D]: doc(star)})), /malformed.*popup/);
  assert.throws(() => effectivePolicy(pol({[D]: doc({})}), {grants: {[D]: {branches: star}}}), /malformed.*popup/);
  const p = effectivePolicy(undefined, {docs: {[D]: {source: "created", added: 1, actions: {}, branches: star}}});
  assert.equal(tabMode(p, D, W, E), "write");
});

test("created docs may not carry admin", () => {
  assert.throws(() => effectivePolicy(undefined, {docs: {[D]: {source: "created", added: 1, actions: {admin: true}, branches: {}}}}), /malformed.*popup/);
});

test("checkPolicy: flags must be boolean, default false", () => {
  assert.throws(() => checkPolicy({version: 2, docs: {}, allow_ui_fallback: "false"}), /malformed.*popup/);
  assert.throws(() => checkPolicy({version: 2, docs: {}, allow_untested_native: 1}), /malformed.*popup/);
  const p = checkPolicy({version: 2, docs: {}});
  assert.equal(p.allow_ui_fallback, false);
  assert.equal(p.allow_untested_native, false);
  assert.equal(checkPolicy({version: 2, docs: {}, allow_ui_fallback: true}).allow_ui_fallback, true);
});
