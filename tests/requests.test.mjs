import test from "node:test";
import assert from "node:assert/strict";
import {fileRequest, liveRequests, approve, approveOnce, pruneApprovals, describeJob, badgeFor} from "../extension/requests.js";
import {tabMode, branchMode, actionOn, hasAnyGrant} from "../extension/grants.js";
import {authorize, AccessError, jobKey} from "../extension/policy.js";

const D = "a".repeat(24), D2 = "f".repeat(24), W = "b".repeat(24), W2 = "c".repeat(24), E = "d".repeat(24), E2 = "e".repeat(24);
const H = 3_600_000;
const tabNeed = (over = {}) => ({did: D, type: "tab", wid: W, eid: E, mode: "read", ...over});
const act = (a, did = D) => ({did, type: "action", action: a});
const pol = docs => ({version: 2, docs, allow_untested_native: false, allow_ui_fallback: false});
const doc = (branches = {}, actions = {}) => ({actions, branches});
const req = need => Object.values(fileRequest({}, need, 1000))[0];

test("dedupe: same need bumps count and last_seen", () => {
  let r = fileRequest({}, tabNeed(), 1000);
  r = fileRequest(r, {mode: "read", eid: E, wid: W, type: "tab", did: D}, 2000);  // key order irrelevant
  const all = liveRequests(r, 2000);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].count, all[0].first_seen, all[0].last_seen], [2, 1000, 2000]);
  assert.deepEqual(all[0].need, tabNeed());
  assert.equal(typeof all[0].id, "string");
  // a different mode is a different need
  assert.equal(liveRequests(fileRequest(r, tabNeed({mode: "write"}), 2100), 2100).length, 2);
});

test("cap 20: keeps the 20 most recent", () => {
  let r = {};
  for (let i = 0; i < 25; i++) r = fileRequest(r, tabNeed({eid: i.toString(16).padStart(24, "0")}), 1000 + i);
  const all = liveRequests(r, 2000);
  assert.equal(all.length, 20);
  assert.equal(all[0].first_seen, 1024);  // newest first
  assert.equal(all[19].first_seen, 1005);
  assert.equal(Object.keys(r).length, 20);
});

test("expiry 1h", () => {
  let r = fileRequest({}, tabNeed(), 1000);
  assert.equal(liveRequests(r, 1000 + H).length, 1);
  assert.equal(liveRequests(r, 1001 + H).length, 0);
  r = fileRequest(r, tabNeed({eid: E2}), 1001 + H);  // filing prunes the stale one
  assert.equal(Object.keys(r).length, 1);
});

test("admin and merge actions are not filed", () => {
  const r = {};
  assert.equal(fileRequest(r, act("admin"), 1), r);
  assert.equal(fileRequest(r, act("merge"), 1), r);
  assert.equal(Object.keys(fileRequest(r, act("tabs"), 1)).length, 1);
});

test("approval needs are filed with method and an ids-only path summary", () => {
  const job = {kind: "rest", method: "POST", path: `/api/v6/documents/${D}/workspaces/${W}/merge?x=secret`, body: {workspaceId: W2, note: "secret"}};
  const need = {did: D, type: "approval", critical: "merge", key: jobKey(job)};
  const r = Object.values(fileRequest({}, need, 5, describeJob(job)))[0];
  assert.equal(r.method, "POST");
  assert.equal(r.path_summary, `/api/v6/documents/${D}/workspaces/${W}/merge`);
  assert.ok(!JSON.stringify([r.method, r.path_summary]).includes("secret"));
});

test("liveRequests tolerates missing input", () => {
  assert.deepEqual(liveRequests(undefined, 1), []);
});

test("approve grants exactly the need", () => {
  const ctx = {did: D, wid: W};
  const p0 = pol({[D]: doc({[W]: {tabs: {}}})});
  const r = approve(p0, req(tabNeed()), ctx);
  assert.equal(r.ok, true);
  assert.equal(tabMode(r.policy, D, W, E), "read");
  assert.equal(tabMode(r.policy, D, W, E2), null);  // other tab untouched
  assert.equal(tabMode(r.policy, D, W2, E), null);  // other branch untouched
  assert.equal(tabMode(p0, D, W, E), null);  // input not mutated
  // read request never grants write; existing write is not downgraded
  const w = approve(r.policy, req(tabNeed({mode: "write"})), ctx);
  assert.equal(tabMode(w.policy, D, W, E), "write");
  assert.equal(tabMode(approve(w.policy, req(tabNeed()), ctx).policy, D, W, E), "write");
  // action: toggles exactly that one on
  const a = approve(p0, req(act("versions")), ctx);
  assert.equal(actionOn(a.policy, D, "versions"), true);
  assert.equal(actionOn(a.policy, D, "branches"), false);
  // whole branch
  const b = approve(p0, req({did: D, type: "branch", wid: W, mode: "write"}), ctx);
  assert.equal(branchMode(b.policy, D, W), "write");
  assert.equal(b.ok, true);
});

test("approve of a tab need with a concrete branch works without the popup on that document when the doc has grants", () => {
  const p0 = pol({[D]: doc({[W]: {tabs: {[E2]: {mode: "read"}}}})});
  const r = approve(p0, req(tabNeed()), {did: D2, wid: W2});
  assert.equal(r.ok, true);
  assert.equal(tabMode(r.policy, D, W, E), "read");
});

test("approve: wid null tab need is granted on the popup's branch", () => {
  const p0 = pol({[D]: doc({[W2]: {tabs: {[E2]: {mode: "read"}}}})});
  const r = approve(p0, req(tabNeed({wid: null})), {did: D, wid: W2});
  assert.equal(r.ok, true);
  assert.equal(tabMode(r.policy, D, W2, E), "read");
  const other = approve(p0, req(tabNeed({wid: null})), {did: D2, wid: W2});
  assert.equal(other.ok, false);
  assert.equal(other.policy, p0);
  assert.match(other.reason, /open this document first/i);
  assert.equal(approve(p0, req(tabNeed({wid: null})), {did: D}).ok, false);  // no branch in the popup
});

test("approve refuses when the popup context is another document", () => {
  const p0 = pol({});
  // no grant at all on D: no blind cross-document approvals
  for (const need of [tabNeed(), act("tabs"), {did: D, type: "branch", wid: W, mode: "read"}]) {
    const r = approve(p0, req(need), {did: D2, wid: W});
    assert.equal(r.ok, false);
    assert.equal(r.policy, p0);
    assert.match(r.reason, /open this document first/i);
  }
  assert.equal(approve(p0, req(tabNeed()), undefined).ok, false);
  // popup on the document: allowed, doc entry created
  const r = approve(p0, req(tabNeed()), {did: D, wid: W, names: {doc: "Robot", branch: "Main", tab: "Arm"}});
  assert.equal(r.ok, true);
  assert.equal(r.policy.docs[D].name, "Robot");
  assert.equal(r.policy.docs[D].branches[W].name, "Main");
  assert.equal(tabMode(r.policy, D, W, E), "read");
  // action on a document with no grant at all, popup elsewhere
  assert.equal(hasAnyGrant(approve(p0, req(act("versions")), {did: D2}).policy, D), false);
});

test("approve: branch needs only on the popup's own branch", () => {
  const p0 = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}})});
  const need = {did: D, type: "branch", wid: W, mode: "read"};
  assert.equal(approve(p0, req(need), {did: D, wid: W2}).ok, false);
  assert.equal(approve(p0, req(need), {did: D2, wid: W}).ok, false);
  assert.equal(approve(p0, req(need), {did: D, wid: W}).ok, true);
});

test("approve: branch_write, overview, admin, merge, approval and malformed needs are not approvable", () => {
  const p0 = pol({[D]: doc({[W]: {tabs: {[E]: {mode: "read"}}}})});
  const ctx = {did: D, wid: W};
  const needs = [{did: D, type: "branch_write", wid: W}, {did: D, type: "overview"}, act("admin"), act("merge"), act("bogus"),
    {did: D, type: "approval", critical: "merge", key: "{}"}, tabNeed({mode: "owner"}), tabNeed({did: "zz"}), {did: D, type: "nope"}, null];
  for (const need of needs) {
    const r = approve(p0, {id: "x", need}, ctx);
    assert.equal(r.ok, false, JSON.stringify(need));
    assert.equal(r.policy, p0);
    assert.equal(typeof r.reason, "string");
  }
});

test("approve never writes a '*' key and bounds names", () => {
  const long = "x".repeat(500);
  const r = approve(pol({}), req(tabNeed()), {did: D, wid: W, eid: E, names: {doc: long, branch: 5, tab: "T"}});
  assert.equal(r.policy.docs[D].name.length, 120);
  assert.equal(r.policy.docs[D].branches[W].name, undefined);
  assert.equal(r.policy.docs[D].branches[W].tabs[E].name, "T");
  assert.equal(JSON.stringify(r.policy).includes('"*"'), false);
});

test("one-shot approval is bound to the exact job and consumed", () => {
  const granted = pol({[D]: doc({[W]: {all: "write", tabs: {}}}, {merge: true})});
  const job = {kind: "rest", method: "POST", path: `/api/v6/documents/${D}/workspaces/${W}/merge`, body: {id: W2, type: "version"}};
  let need;
  try { authorize(job, granted, {}, [], 1000); assert.fail("must need approval"); } catch (e) { assert.ok(e instanceof AccessError); need = e.need; }
  assert.equal(need.type, "approval");
  const filed = Object.values(fileRequest({}, need, 1000, describeJob(job)))[0];
  const approvals = approveOnce({}, filed.need.key, 1000);
  assert.equal(approvals[need.key], 1000 + 300_000);
  assert.ok(authorize(job, granted, approvals, {}, 2000).approvalKey);                 // passes once
  assert.throws(() => authorize(job, granted, approvals, {[need.key]: approvals[need.key]}, 2000), AccessError);  // consumed
  // used once -> refused -> approve again -> allowed once more (fresh expiry differs from the consumed one)
  const used = {[need.key]: approvals[need.key]};
  const again = approveOnce(approvals, need.key, 1500);
  assert.notEqual(again[need.key], approvals[need.key]);
  assert.ok(authorize(job, granted, again, used, 2000).approvalKey);
  assert.throws(() => authorize(job, granted, again, {[need.key]: again[need.key]}, 2000), AccessError);
  assert.throws(() => authorize(job, granted, approvals, [need.key], 2000), AccessError);  // consumed must be a map
  assert.throws(() => authorize({...job, body: {id: E, type: "version"}}, granted, approvals, {}, 2000), AccessError);  // other body
  assert.throws(() => authorize(job, granted, approvals, {}, 1000 + 300_000), AccessError);  // expired
});

test("pruneApprovals drops expired approvals and stale consumed entries", () => {
  const approvals = {k1: 500, k2: 5000, k3: 6000};
  const r = pruneApprovals(approvals, {k1: 500, k2: 5000, k3: 5999, gone: 7000}, 1000);
  assert.deepEqual(r.approvals, {k2: 5000, k3: 6000});
  assert.deepEqual(r.consumed, {k2: 5000});
  assert.deepEqual(pruneApprovals(undefined, undefined, 1), {approvals: {}, consumed: {}});
});

test("approveOnce never reuses an expiry and approve tolerates non-string ids", () => {
  assert.equal(approveOnce({k: 1000 + 300_000 + 50}, "k", 1000).k, 1000 + 300_000 + 51);
  const p0 = pol({[D]: doc({[W]: {tabs: {}}})});
  for (const need of [tabNeed({did: 5}), tabNeed({eid: {}}), tabNeed({wid: 7}), tabNeed({did: [D]})]) {
    const r = approve(p0, {id: "x", need}, {did: D, wid: W});
    assert.deepEqual([r.ok, r.reason, r.policy], [false, "Malformed request.", p0]);
  }
});

test("badgeFor shows the live request count in orange, else ON/OFF", () => {
  const now = 10 * H, r = {x: {last_seen: now - 1}, y: {last_seen: now - H - 1}};
  assert.deepEqual(badgeFor(r, now, true), {text: "1", color: "#d97706"});
  assert.deepEqual(badgeFor({}, now, true), {text: "ON"});
  assert.deepEqual(badgeFor(undefined, now, false), {text: "OFF"});
});
