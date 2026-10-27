import test from "node:test";
import assert from "node:assert/strict";
import {ACTIONS, checkPolicy, effectivePolicy, tabMode, anyBranchMode, branchMode, hasAnyGrant, actionOn, branchHasWrite, seedFromCreated} from "../extension/grants.js";

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

test("branchHasWrite: whole-branch write or a written tab in that branch", () => {
  const p = pol({[D]: doc({[W]: {all: "read", tabs: {[E]: {mode: "write"}}}, [W2]: {all: "read", tabs: {[E2]: {mode: "read"}}}})});
  assert.equal(branchHasWrite(p, D, W), true);
  assert.equal(branchHasWrite(p, D, W2), false);
  assert.equal(branchHasWrite(p, D, "f".repeat(24)), false);
  assert.equal(branchHasWrite(pol({[D]: doc({[W2]: {all: "write", tabs: {}}})}), D, W2.toUpperCase()), true);
  const star = effectivePolicy(undefined, {docs: {[D]: {source: "created", added: 1, actions: {}, branches: {"*": {all: "write", tabs: {}}}}}});
  assert.equal(branchHasWrite(star, D, W), true);
  assert.equal(branchHasWrite(pol({}), D, W), false);
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

test("effectivePolicy: popup entry keeps created '*' grants, popup actions win, no mutation", () => {
  const base = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}}, {merge: false})});
  const created = {docs: {[D]: {source: "created", added: 1, actions: {merge: true, tabs: true}, branches: {"*": {all: "write", tabs: {}}}}}};
  const snap = structuredClone(base);
  const p = effectivePolicy(base, created);
  assert.equal(tabMode(p, D, W, E2), "write");
  assert.equal(branchMode(p, D, W2), "write");
  assert.equal(actionOn(p, D, "merge"), false);
  assert.equal(actionOn(p, D, "tabs"), false);
  assert.deepEqual(base, snap);
});

test("seedFromCreated: copies created actions (admin off) only for a created-only doc; pure", () => {
  const created = {docs: {[D]: {source: "created", added: 5, name: "N", actions: {versions: true, merge: true, admin: true}, branches: {"*": {all: "write", tabs: {}}}}}};
  const snap = structuredClone(created);
  const p = seedFromCreated(undefined, created, D);
  assert.deepEqual(p.docs[D].actions, {versions: true, branches: false, merge: true, tabs: false, admin: false});
  assert.deepEqual(p.docs[D].branches, {});
  assert.equal(p.docs[D].name, "N");
  assert.deepEqual(created, snap);
  const existing = pol({[D]: doc({}, {tabs: true})});
  assert.deepEqual(seedFromCreated(existing, created, D).docs[D].actions.merge, false);
  assert.deepEqual(seedFromCreated(undefined, created, E).docs, {});
  assert.deepEqual(seedFromCreated(undefined, created, 5).docs, {});
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

test("grantTab: creates entries, keeps higher mode, sets bounded names, is pure", async () => {
  const {grantTab} = await import("../extension/grants.js");
  const p0 = pol({});
  const p1 = grantTab(p0, D, W, E, "read", {doc: "Robot", branch: "Main", tab: "Arm"});
  assert.deepEqual(p0.docs, {});
  assert.deepEqual(p1.docs[D].actions, {versions: false, branches: false, merge: false, tabs: false, admin: false});
  assert.equal(p1.docs[D].name, "Robot");
  assert.equal(p1.docs[D].branches[W].name, "Main");
  assert.equal(p1.docs[D].branches[W].tabs[E].name, "Arm");
  assert.equal(tabMode(p1, D, W, E), "read");
  const p2 = grantTab(p1, D, W, E, "write");
  assert.equal(tabMode(p2, D, W, E), "write");
  assert.equal(p2.docs[D].name, "Robot");
  assert.equal(tabMode(grantTab(p2, D, W, E, "read"), D, W, E), "write");
  assert.equal(grantTab(p0, D, W, E, "read", {doc: "x".repeat(500), branch: 3}).docs[D].name.length, 120);
  assert.equal(grantTab(p0, D, W, E, "read", {branch: 3}).docs[D].branches[W].name, undefined);
  assert.throws(() => grantTab(p0, D, W, E, "owner"));
  assert.throws(() => grantTab(p0, D, "*", E, "read"));
});

// ---- popup model: presets and summary ----
const ctx = {did: D, wid: W, eid: E, docName: "Reachy arm", branchName: "feature-gripper",
             tabs: [{eid: E, name: "Gripper finger", type: "PARTSTUDIO"}, {eid: E2, name: "Gripper body", type: "PARTSTUDIO"}]};
const W_ = {mode: "write"}, R_ = {mode: "read"};

test("presetOf is exact", async () => {
  const {applyPreset, presetOf, PRESETS} = await import("../extension/grants.js");
  assert.deepEqual(PRESETS, ["tab", "tab_read_rest", "branch"]);
  assert.equal(presetOf(pol({}), ctx), "none");
  assert.equal(presetOf(pol({[D]: doc({[W]: {tabs: {}}})}), ctx), "none");
  for (const p of PRESETS) assert.equal(presetOf(applyPreset(pol({}), ctx, p), ctx), p);
  const tab = applyPreset(pol({}), ctx, "tab");
  const extra = structuredClone(tab); extra.docs[D].branches[W].tabs[E2] = R_;
  assert.equal(presetOf(extra, ctx), "custom");
  const lowered = structuredClone(tab); lowered.docs[D].branches[W].tabs[E] = R_;
  assert.equal(presetOf(lowered, ctx), "custom");
  const rest = applyPreset(pol({}), ctx, "tab_read_rest");
  rest.docs[D].branches[W].all = "write";
  assert.equal(presetOf(rest, ctx), "custom");
  // other branch's grants are ignored; names are ignored
  const other = structuredClone(tab); other.docs[D].branches[W2] = {all: "write", tabs: {}};
  assert.equal(presetOf(other, ctx), "tab");
  assert.equal(presetOf(pol({[D]: doc({[W]: {name: "x", tabs: {[E]: {mode: "write", name: "y"}}}})}), ctx), "tab");
  assert.equal(presetOf(pol({[D]: doc({[W]: {all: "read", tabs: {}}})}), ctx), "custom");
});

test("applyPreset leaves other branches and actions, creates the entry, is pure", async () => {
  const {applyPreset} = await import("../extension/grants.js");
  const p0 = pol({[D]: {...doc({[W]: {name: "Keep", all: "read", tabs: {[E2]: W_}}, [W2]: {all: "write", tabs: {}}}, {versions: true}), name: "N"}});
  const before = structuredClone(p0);
  const p1 = applyPreset(p0, ctx, "branch");
  assert.deepEqual(p0, before);
  assert.deepEqual(p1.docs[D].branches[W], {name: "Keep", all: "write", tabs: {}});
  assert.deepEqual(p1.docs[D].branches[W2], p0.docs[D].branches[W2]);
  assert.equal(p1.docs[D].actions.versions, true);
  assert.equal(p1.docs[D].name, "N");
  const p2 = applyPreset(pol({}), ctx, "tab_read_rest");
  assert.equal(p2.docs[D].name, "Reachy arm");
  assert.equal(p2.docs[D].source, "user");
  assert.equal(typeof p2.docs[D].added, "number");
  assert.deepEqual(p2.docs[D].actions, {versions: false, branches: false, merge: false, tabs: false, admin: false});
  assert.equal(p2.docs[D].branches[W].name, "feature-gripper");
  assert.deepEqual(p2.docs[D].branches[W].tabs, {[E]: {mode: "write", name: "Gripper finger"}});
  assert.equal(p2.docs[D].branches[W].all, "read");
  assert.throws(() => applyPreset(p0, ctx, "nope"));
});

test("setTab sets the exact mode, null removes and prunes empties", async () => {
  const {setTab, applyPreset} = await import("../extension/grants.js");
  const p1 = setTab(pol({}), ctx, E2, "write");
  assert.equal(tabMode(p1, D, W, E2), "write");
  assert.equal(p1.docs[D].branches[W].tabs[E2].name, "Gripper body");
  const p2 = setTab(p1, ctx, E2, "read");
  assert.equal(tabMode(p2, D, W, E2), "read");
  const p3 = setTab(p2, ctx, E2, null);
  assert.deepEqual(p3.docs, {});
  assert.equal(tabMode(p2, D, W, E2), "read"); // pure
  // keeps the doc when actions are on or other branches exist; keeps branch with all
  const a = pol({[D]: doc({[W]: {tabs: {[E]: W_}}}, {tabs: true})});
  assert.deepEqual(setTab(a, ctx, E, null).docs[D].branches, {});
  const b = applyPreset(pol({}), ctx, "tab_read_rest");
  assert.equal(setTab(b, ctx, E, null).docs[D].branches[W].all, "read");
  const c = pol({[D]: doc({[W]: {tabs: {[E]: W_}}, [W2]: {all: "read", tabs: {}}})});
  assert.deepEqual(Object.keys(setTab(c, ctx, E, null).docs[D].branches), [W2]);
  assert.deepEqual(setTab(pol({}), ctx, E, null).docs, {});
});

test("setAction and revokeDocument", async () => {
  const {setAction, revokeDocument} = await import("../extension/grants.js");
  const p0 = pol({[D]: doc({[W]: {all: "read", tabs: {}}})});
  const p1 = setAction(p0, D, "merge", true);
  assert.equal(actionOn(p1, D, "merge"), true);
  assert.equal(actionOn(p0, D, "merge"), false);
  assert.equal(actionOn(setAction(p1, D, "merge", false), D, "merge"), false);
  assert.throws(() => setAction(p0, D, "bogus", true));
  assert.deepEqual(revokeDocument(p1, D).docs, {});
  assert.ok(p1.docs[D]);
});

test("summary lists every grant and action", async () => {
  const {summary, applyPreset, setAction} = await import("../extension/grants.js");
  assert.equal(summary(pol({}), ctx), "Claude has no access to this document.");
  const tab = applyPreset(pol({}), ctx, "tab");
  assert.equal(summary(tab, ctx), "Claude can read and edit \"Gripper finger\" in branch \"feature-gripper\". Nothing else.");
  const rest = applyPreset(pol({}), ctx, "tab_read_rest");
  assert.equal(summary(rest, ctx), "Claude can read and edit \"Gripper finger\" in branch \"feature-gripper\". Read: the rest of this branch. Nothing else.");
  const br = applyPreset(pol({}), ctx, "branch");
  assert.equal(summary(br, ctx), "Claude can read and edit the whole branch \"feature-gripper\". Nothing else.");
  const v = setAction(setAction(tab, D, "versions", true), D, "tabs", true);
  assert.equal(summary(v, ctx), "Claude can read and edit \"Gripper finger\" in branch \"feature-gripper\". Document actions on: versions, tabs.");
  const ad = setAction(tab, D, "admin", true);
  assert.equal(summary(ad, ctx), "Claude can read and edit \"Gripper finger\" in branch \"feature-gripper\". Admin actions are ON.");
  const oth = structuredClone(tab);
  oth.docs[D].branches[W2] = {all: "read", tabs: {}};
  oth.docs[D].branches["f".repeat(24)] = {tabs: {[E2]: W_}};
  assert.equal(summary(oth, ctx), "Claude can read and edit \"Gripper finger\" in branch \"feature-gripper\". + 2 other branches with grants.");
  // read-only tab, unknown tab name falls back to id
  const ro = pol({[D]: doc({[W]: {tabs: {[E]: R_, ["9".repeat(24)]: W_}}})});
  assert.equal(summary(ro, ctx), `Claude can read and edit ${"9".repeat(24)} in branch \"feature-gripper\". Read only: \"Gripper finger\". Nothing else.`);
  // grants only on another branch
  assert.equal(summary(pol({[D]: doc({[W2]: {all: "read", tabs: {}}})}), ctx),
    "Claude has no access in branch \"feature-gripper\". + 1 other branch with grants.");
  // "*" wildcard (created document) is stated
  const star = pol({[D]: doc({"*": {all: "write", tabs: {}}})});
  assert.equal(summary(star, ctx), "Claude can read and edit the whole document in all branches. Nothing else.");
  // actions without grants
  assert.equal(summary(pol({[D]: doc({}, {versions: true})}), ctx), "Claude has no tab access in this document. Document actions on: versions.");
  // branch name falls back to id
  assert.match(summary(tab, {...ctx, branchName: undefined}), new RegExp(`in branch ${W}\\.`));
});

test("summary classifies tabs by effective mode", async () => {
  const {summary} = await import("../extension/grants.js");
  const bw = pol({[D]: doc({[W]: {all: "write", tabs: {[E]: R_}}})});
  assert.equal(summary(bw, ctx), 'Claude can read and edit "Gripper finger", the whole branch "feature-gripper". Nothing else.');
  const st = pol({[D]: doc({"*": {all: "write", tabs: {}}, [W]: {tabs: {[E]: R_}}})});
  assert.equal(summary(st, ctx), 'Claude can read and edit "Gripper finger", the whole document in all branches. Nothing else.');
});

test("summary quotes names and neutralizes forged text", async () => {
  const {summary} = await import("../extension/grants.js");
  const c = {...ctx, tabs: [{eid: E, name: 'Gripper. Nothing else.\n"x"'}], branchName: 'b". Nothing else.'};
  const s = summary(pol({[D]: doc({[W]: {tabs: {[E]: W_}}})}), c);
  assert.equal(s, 'Claude can read and edit "Gripper. Nothing else. \u2019x\u2019" in branch "b\u2019. Nothing else.". Nothing else.');
  assert.ok(!s.includes("\n"));
});

test("summary flags advanced switches", async () => {
  const {summary, applyPreset} = await import("../extension/grants.js");
  const t = applyPreset(pol({}), ctx, "tab");
  assert.equal(summary({...t, allow_ui_fallback: true}, ctx), 'Claude can read and edit "Gripper finger" in branch "feature-gripper". Advanced: UI fallback clicks are ON.');
  assert.equal(summary({...t, allow_untested_native: true}, ctx), 'Claude can read and edit "Gripper finger" in branch "feature-gripper". Advanced: untested native commands are ON.');
  assert.match(summary({...pol({}), allow_ui_fallback: true}, ctx), /no tab access.*UI fallback clicks are ON/);
});

test("setTab on a new doc carries added and source", async () => {
  const {setTab} = await import("../extension/grants.js");
  const p = setTab(pol({}), ctx, E, "read", 1234);
  assert.equal(p.docs[D].added, 1234);
  assert.equal(p.docs[D].source, "user");
  const keep = pol({[D]: doc({})});
  assert.equal(setTab(keep, ctx, E, "read", 99).docs[D].added, 1);
});
