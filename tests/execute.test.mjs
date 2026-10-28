import test from "node:test";
import assert from "node:assert/strict";
import {execute, fromPopup, popupStorageMessage} from "../extension/execute.js";
import {AccessError, jobKey} from "../extension/policy.js";

const D = "a".repeat(24), W = "b".repeat(24), W2 = "c".repeat(24), E = "d".repeat(24), E2 = "e".repeat(24);
const NEW = "9".repeat(24);
// In-memory chrome.storage.local: get(keys) / set(items) promises, values copied like structured cloning.
function fakeStorage(init = {}, failSet = () => false) {
  const data = structuredClone(init);
  return {data, writes: [],
    async get(keys) { return Object.fromEntries([keys].flat().filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(items) { if (failSet(items)) throw new Error("storage write failed"); this.writes.push(Object.keys(items)); Object.assign(data, structuredClone(items)); }};
}
const runtime = {id: "ext", getURL: path => `chrome-extension://ext/${path}`};
const popup = {id: "ext", url: "chrome-extension://ext/popup.html"};
const merge = {kind: "rest", method: "POST", path: `/api/v10/documents/${D}/workspaces/${W}/merge`, query: {}, body: {id: W2, type: "version"}};
const mergePolicy = {version: 2, docs: {[D]: {actions: {merge: true}, branches: {[W]: {all: "write", tabs: {}}}}}};
const later = () => Date.now() + 60_000;

test("execute consumes the one-shot approval before running the job", async () => {
  const key = jobKey(merge), expires = later();
  const storage = fakeStorage({policy: mergePolicy, approvals: {[key]: expires}});
  let consumedAtRun;
  const result = await execute(merge, {storage, run: async () => { consumedAtRun = structuredClone(storage.data.consumed); return {status: 200, body: {}}; }});
  assert.deepEqual(result, {status: 200, body: {}});
  assert.deepEqual(consumedAtRun, {[key]: expires});
  // A second identical run is refused: the approval was used.
  let ran = false;
  await assert.rejects(execute(merge, {storage, run: async () => { ran = true; }}), AccessError);
  assert.equal(ran, false);
});

test("execute does not run the job when the consumed write fails", async () => {
  const key = jobKey(merge);
  const storage = fakeStorage({policy: mergePolicy, approvals: {[key]: later()}}, items => "consumed" in items);
  let ran = false;
  await assert.rejects(execute(merge, {storage, run: async () => { ran = true; }}), /storage write failed/);
  assert.equal(ran, false);
});

test("an AccessError files a request for the missing need and is rethrown", async () => {
  const storage = fakeStorage({policy: {version: 2, docs: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "read"}}}}}}}});
  const job = {kind: "rest", method: "POST", path: `/api/v10/partstudios/d/${D}/w/${W}/e/${E}/features`, query: {}, body: {}};
  let badge = 0, ran = false;
  await assert.rejects(execute(job, {storage, run: async () => { ran = true; }, refreshBadge: async () => { badge++; }}),
    error => error instanceof AccessError && /An access request was filed/.test(error.message));
  assert.equal(ran, false);
  assert.equal(badge, 1);
  const [request] = Object.values(storage.data.requests);
  assert.deepEqual(request.need, {did: D, type: "tab", wid: W, eid: E, mode: "write"});
  // A merge approval request carries the description of what it does.
  const m = fakeStorage({policy: mergePolicy});
  await assert.rejects(execute(merge, {storage: m, run: async () => {}}), AccessError);
  assert.equal(Object.values(m.data.requests)[0].details.kind, "merge");
  // Plain refusals (not access needs) file nothing.
  const none = fakeStorage({policy: {version: 2, docs: {}}});
  await assert.rejects(execute({kind: "rest", method: "GET", path: "/api/v10/folders/x", query: {}}, {storage: none, run: async () => {}}), /no document id/);
  assert.equal(none.data.requests, undefined);
});

test("execute runs the authorized job with policy trust fields and records created documents", async () => {
  const storage = fakeStorage({policy: {version: 2, docs: {}, allow_create_documents: true}});
  let seen;
  const job = {kind: "rest", method: "POST", path: "/api/v10/documents", query: {}, body: {name: "New"}, admin_allowed: true, allow_untested_native: true};
  await execute(job, {storage, run: async j => { seen = j; return {status: 200, body: {id: NEW, name: "New"}}; }});
  assert.equal(seen.admin_allowed, false);
  assert.equal(seen.allow_untested_native, false);
  assert.equal(storage.data.created.docs[NEW].branches["*"].all, "write");
  // The worker never writes the popup's keys.
  assert.ok(storage.writes.flat().every(k => ["created", "requests", "consumed", "rate"].includes(k)));
});

test("popup storage messages reject every non-popup sender", async () => {
  const init = {requests: {r1: {id: "r1"}}, created: {docs: {[D]: {}}, grants: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "write"}}}}}}}};
  const messages = [{type: "resolve_request", id: "r1"}, {type: "revoke_created", did: D}, {type: "revoke_created_grant", did: D, wid: W, eid: E}];
  for (const sender of [undefined, {}, {id: "other", url: popup.url}, {id: "ext", url: "chrome-extension://ext/other.html"},
    {id: "ext", url: "https://cad.onshape.com/documents/x", tab: {id: 1}}]) {
    assert.equal(fromPopup(sender, runtime), false);
    const storage = fakeStorage(init);
    for (const message of messages) assert.equal(popupStorageMessage(message, sender, {storage, runtime}), null);
    assert.deepEqual(storage.data, init);
  }
  assert.equal(fromPopup(popup, runtime), true);
  assert.equal(popupStorageMessage({type: "connect"}, popup, {storage: fakeStorage(), runtime}), null);
});

test("popup storage messages from the popup update worker-owned storage", async () => {
  const created = {docs: {[D]: {x: 1}}, grants: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "write"}, [E2]: {mode: "read"}}}}}}};
  let storage = fakeStorage({requests: {r1: {id: "r1"}, r2: {id: "r2"}}, created});
  await popupStorageMessage({type: "resolve_request", id: "r1"}, popup, {storage, runtime});
  assert.deepEqual(Object.keys(storage.data.requests), ["r2"]);
  await popupStorageMessage({type: "revoke_created_grant", did: D, wid: W, eid: E}, popup, {storage, runtime});
  assert.deepEqual(storage.data.created.grants[D].branches[W].tabs, {[E2]: {mode: "read"}});
  await popupStorageMessage({type: "revoke_created_grant", did: D, wid: W}, popup, {storage, runtime});
  assert.deepEqual(storage.data.created.grants, {});
  assert.deepEqual(storage.data.created.docs, {[D]: {x: 1}});
  // Malformed ids change nothing.
  storage = fakeStorage({created});
  await popupStorageMessage({type: "revoke_created_grant", did: D, wid: "*", eid: E}, popup, {storage, runtime});
  assert.deepEqual(storage.data.created, created);
  await popupStorageMessage({type: "revoke_created", did: D}, popup, {storage, runtime});
  assert.deepEqual(storage.data.created, {docs: {}, grants: {}});
});

const readPolicy = {version: 2, docs: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "read"}}}}}}};
const features = {kind: "rest", method: "GET", path: `/api/v10/partstudios/d/${D}/w/${W}/e/${E}/features`, query: {}};

test("execute records each REST call and refuses an endpoint Onshape rate-limited, without sending", async () => {
  const storage = fakeStorage({policy: readPolicy});
  let sent = 0;
  const limited = async () => { sent++; return {status: 429, body: {}, response_headers: {"retry-after": "600"}}; };
  await execute(features, {storage, run: limited});
  assert.equal(storage.data.rate.count, 1);
  assert.ok(storage.data.rate.blocked["GET /api/v10/partstudios/d/:id/:wvm/:id/e/:id/features"]);
  await assert.rejects(execute(features, {storage, run: limited}), /HTTP 429\); nothing was sent/);
  assert.equal(sent, 1);
  // A rate refusal is not an access need: no popup request is filed.
  assert.equal(storage.data.requests, undefined);
});

test("execute applies the popup's caps and counts calls that failed without an answer", async () => {
  const storage = fakeStorage({policy: readPolicy, rate_limits: {perMinute: 1, perDay: 100}});
  await assert.rejects(execute(features, {storage, run: async () => { throw new Error("network down"); }}), /network down/);
  assert.equal(storage.data.rate.count, 1);
  let ran = false;
  await assert.rejects(execute(features, {storage, run: async () => { ran = true; }}), /1 calls per minute/);
  assert.equal(ran, false);
});

test("editor jobs are not counted by the rate guard", async () => {
  const storage = fakeStorage({policy: readPolicy});
  const native = {kind: "native", target: {did: D, wid: W, eid: E}, command: "ui.GBTUiMassPropCall", body: {}};
  await execute(native, {storage, run: async () => ({result: {}})});
  assert.equal(storage.data.rate, undefined);
});

test("execute waits the guard's spacing before sending, without refusing", async () => {
  const storage = fakeStorage({policy: readPolicy});
  const waits = [];
  const deps = {storage, run: async () => ({status: 200, body: {}, response_headers: {}}), sleep: async ms => { waits.push(ms); }};
  await execute(features, deps);
  await execute(features, deps);
  assert.equal(storage.data.rate.count, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 250);
});
