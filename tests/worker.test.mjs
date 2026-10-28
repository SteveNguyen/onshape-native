// worker.js runs at load time against chrome, fetch and WebSocket. Each test loads a fresh copy of the extension
// modules from a temporary folder (local-config.js is per-install and git-ignored, so a stub token is written there)
// with those globals replaced by fakes.
import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {cpSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const TOKEN = "worker-test-token-".repeat(3);
const D = "a".repeat(24), W = "b".repeat(24), E = "c".repeat(24);
const mac = message => createHmac("sha256", TOKEN).update(message).digest("hex");
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static made = [];
  constructor(url) { this.url = url; this.readyState = FakeSocket.CONNECTING; this.sent = []; FakeSocket.made.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === FakeSocket.CLOSED) return; this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  async deliver(message) { await this.onmessage({data: JSON.stringify(message)}); }
}

function fakeChrome(local) {
  const listeners = {alarm: [], startup: [], message: []};
  const chrome = {
    listeners,
    storage: {local: {data: structuredClone(local),
      async get(keys) { return Object.fromEntries([keys].flat().filter(k => k in this.data).map(k => [k, structuredClone(this.data[k])])); },
      async set(items) { Object.assign(this.data, structuredClone(items)); }},
      onChanged: {addListener() {}}},
    runtime: {id: "ext", getURL: p => `chrome-extension://ext/${p}`, getManifest: () => ({version: "test"}),
              onStartup: {addListener: f => listeners.startup.push(f)}, onMessage: {addListener: f => listeners.message.push(f)}},
    alarms: {create() {}, onAlarm: {addListener: f => listeners.alarm.push(f)}},
    action: {setBadgeText() {}, setBadgeBackgroundColor() {}},
    tabs: {async query() { return []; }},
  };
  return chrome;
}

let dir, loads = 0;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-test-"));
  cpSync(new URL("../extension/", import.meta.url), dir, {recursive: true, filter: src => !src.endsWith("local-config.js")});
  writeFileSync(join(dir, "local-config.js"), `export const BRIDGE_TOKEN = ${JSON.stringify(TOKEN)};\n`);
});
test.after(() => rmSync(dir, {recursive: true, force: true}));

// Loads a fresh worker with the given storage and fetch; returns the fakes. Sockets are closed after each test so
// the worker's heartbeat interval never outlives it.
async function load(t, {local = {enabled: true}, fetch = async () => ({status: 401})} = {}) {
  FakeSocket.made = [];
  const chrome = fakeChrome(local);
  const fetches = [];
  Object.assign(globalThis, {chrome, WebSocket: FakeSocket, fetch: (...args) => { fetches.push(args[0]); return fetch(...args); }});
  t.after(() => { for (const s of FakeSocket.made) s.close(); });
  await import(pathToFileURL(join(dir, "worker.js")).href + `?load=${++loads}`);
  await settle();
  return {chrome, fetches};
}

async function handshake(socket) {
  await socket.deliver({type: "challenge", nonce: "f".repeat(32)});
  const hello = socket.sent.find(m => m.type === "hello");
  socket.readyState = FakeSocket.OPEN;
  await socket.deliver({type: "ready", protocol: 2, mac: mac(`srv\n${hello.nonce}\n${"f".repeat(32)}`)});
}

test("without a bridge no WebSocket is ever opened, on load or on later alarms", async t => {
  const {chrome, fetches} = await load(t, {fetch: async () => { throw new TypeError("Failed to fetch"); }});
  chrome.listeners.alarm[0]({name: "native-reconnect"});
  await settle();
  assert.equal(FakeSocket.made.length, 0);
  assert.equal(fetches.length, 2);
  assert.ok(fetches.every(url => url === "http://127.0.0.1:8766/health"));
});

test("with a bridge answering the probe, one connection opens to the extension endpoint", async t => {
  await load(t);
  assert.deepEqual(FakeSocket.made.map(s => s.url), ["ws://127.0.0.1:8766/extension"]);
});

test("attempts that overlap while the probe is pending send one probe and open a single connection", async t => {
  const probe = deferred();
  const {chrome, fetches} = await load(t, {fetch: () => probe.promise});
  chrome.listeners.alarm[0]({name: "native-reconnect"});
  chrome.listeners.startup[0]();
  await settle();
  assert.equal(fetches.length, 1);  // the pending probe is not duplicated
  probe.resolve({status: 401});
  await settle();
  assert.equal(FakeSocket.made.length, 1);
});

test("a disabled extension neither probes nor connects", async t => {
  const {fetches} = await load(t, {local: {enabled: false}});
  assert.equal(fetches.length, 0);
  assert.equal(FakeSocket.made.length, 0);
});

test("an open connection is kept: later alarms do not probe or reconnect", async t => {
  const {chrome, fetches} = await load(t);
  FakeSocket.made[0].readyState = FakeSocket.OPEN;
  chrome.listeners.alarm[0]({name: "native-reconnect"});
  await settle();
  assert.equal(fetches.length, 1);
  assert.equal(FakeSocket.made.length, 1);
});

test("commands run only after the bridge proves the token", async t => {
  await load(t);
  const socket = FakeSocket.made[0];
  await socket.deliver({type: "challenge", nonce: "f".repeat(32)});
  socket.readyState = FakeSocket.OPEN;
  await socket.deliver({type: "command", id: "1", job: {kind: "tabs"}});
  assert.equal(socket.sent.filter(m => m.type === "result").length, 0);
  assert.equal(socket.readyState, FakeSocket.CLOSED);  // a command before "ready" closes the session
});

test("a second command while one is running is answered 'still running', and both get their result", async t => {
  const policy = {version: 2, docs: {[D]: {branches: {[W]: {tabs: {[E]: {mode: "read"}}}}}}};
  const slow = deferred();
  // Each fetch gets its own Response (a body can be read once), released together when the test says so.
  const answer = () => new Response(JSON.stringify({features: []}), {status: 200, headers: {"content-type": "application/json"}});
  await load(t, {local: {enabled: true, policy}, fetch: url => String(url).includes("/health") ? Promise.resolve({status: 401}) : slow.promise.then(answer)});
  const socket = FakeSocket.made[0];
  await handshake(socket);
  const job = {kind: "rest", method: "GET", path: `/api/v10/partstudios/d/${D}/w/${W}/e/${E}/features`, query: {}};
  const first = socket.deliver({type: "command", id: "1", job});
  await settle();
  const second = socket.deliver({type: "command", id: "2", job});
  slow.resolve();
  await Promise.all([first, second]);
  const results = Object.fromEntries(socket.sent.filter(m => m.type === "result").map(m => [m.id, m.result]));
  assert.match(results["2"].error, /Previous command still running/);
  assert.equal(results["1"].status, 200);
});

test("only the extension's own popup can drive the connection", async t => {
  const {chrome} = await load(t);
  let replied = false;
  const handled = chrome.listeners.message[0]({type: "disconnect"}, {id: "other", url: "https://evil.example/"}, () => { replied = true; });
  assert.equal(handled, undefined);
  assert.equal(replied, false);
  assert.notEqual(FakeSocket.made[0].readyState, FakeSocket.CLOSED);
});
