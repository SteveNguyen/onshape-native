import {pageCommand} from "./page-adapter.js";
import {restGet} from "./rest-get.js";
import {tabContext} from "./tab-context.js";
import {displayCommand} from "./display-adapter.js";
import {BRIDGE_TOKEN} from "./local-config.js";
import {AccessError, authorize, applyPolicy, effectivePolicy, recordCreated} from "./policy.js";
import {badgeFor, describeJob, fileRequest, pruneApprovals} from "./requests.js";
import {bridgeSession} from "./handshake.js";

let socket = null;
let heartbeat = null;
let verified = null;  // the socket whose bridge proved the token
let inFlight = false;
const BASE = "ws://127.0.0.1:8766/extension";

async function settings() { return chrome.storage.local.get(["enabled"]); }

async function resolveTab(job) {
  const tabs = await chrome.tabs.query({url: "https://cad.onshape.com/*"});
  if (job.target) {
    const {did, wid, eid} = job.target;
    const pathname = `/documents/${did}/w/${wid}/e/${eid}`;
    const matches = tabs.filter(t => new URL(t.url).pathname === pathname);
    if (job.tab_id === undefined && matches.length === 1) return matches[0];
    const selected = matches.find(t => t.id === job.tab_id);
    if (selected) return selected;
    throw new Error(matches.length ? "Multiple matching tabs; provide tab_id from bridge_status." : "Open the exact target workspace/element in Comet.");
  }
  const selected = job.tab_id ? tabs.find(t => t.id === job.tab_id) : tabs.find(t => t.active) || tabs[0];
  if (!selected) throw new Error("Open an Onshape tab in Comet.");
  return selected;
}

async function stored() { return chrome.storage.local.get(["policy", "created", "requests", "approvals", "consumed"]); }

const connected = () => !!socket && verified === socket && socket.readyState === WebSocket.OPEN;

// Live request count (orange) wins over ON/OFF; the popup's Allow/Deny changes "requests" in storage.
async function refreshBadge() {
  const {requests} = await chrome.storage.local.get("requests");
  const badge = badgeFor(requests, Date.now(), connected());
  chrome.action.setBadgeText({text: badge.text});
  chrome.action.setBadgeBackgroundColor({color: badge.color ?? "#4b5563"});
}

// A refused agent call becomes a popup request for exactly the missing need. Never masks the refusal.
async function fileAccessRequest(job, error) {
  try {
    const now = Date.now();
    const {requests} = await chrome.storage.local.get("requests");
    const need = error.need;
    await chrome.storage.local.set({requests: fileRequest(requests, need, now, need?.type === "approval" ? describeJob(job) : undefined)});
    await refreshBadge();
  } catch { /* the bridge still gets the original error */ }
}

async function execute(job) {
  // The popup-managed policy is authoritative; bridge-supplied trust fields are overwritten.
  const {policy, created, approvals: rawApprovals, consumed: rawConsumed} = await stored();
  const current = effectivePolicy(policy, created);
  const now = Date.now();
  const {approvals, consumed} = pruneApprovals(rawApprovals, rawConsumed, now);
  const original = job;
  let approvalKey;
  try {
    ({approvalKey} = authorize(job, current, approvals, consumed, now));
    job = applyPolicy(job, current, approvals, consumed, now);
  } catch (error) {
    if (error instanceof AccessError) await fileAccessRequest(original, error);
    throw error;
  }
  const result = await run(job, current);
  // The worker writes only "created", "requests", "consumed", never the popup's "policy"/"approvals".
  // Re-read so a concurrent popup change is kept; commands are already serialized by inFlight.
  if (approvalKey) {
    const latest = await stored();
    const used = latest.approvals?.[approvalKey];
    if (typeof used === "number") {
      const kept = pruneApprovals(latest.approvals, latest.consumed, Date.now()).consumed;
      await chrome.storage.local.set({consumed: {...kept, [approvalKey]: used}});
    }
  }
  if (job.kind === "rest" && job.method !== "GET") {
    const latest = await stored();
    const updated = recordCreated(job, result, latest.policy, latest.created);
    if (updated) await chrome.storage.local.set({created: updated});
  }
  return result;
}

async function run(job, current) {
  if (job.kind === "rest" && job.method === "GET") return restGet(job);
  if (job.kind === "open") {
    const {did,wid,eid} = job.target;
    const url = `https://cad.onshape.com/documents/${did}/w/${wid}/e/${eid}`;
    const matches = (await chrome.tabs.query({url: url + "*"})).filter(t=>new URL(t.url).pathname === new URL(url).pathname);
    if(matches.length>1) throw new Error("Multiple matching editor tabs; supply an exact tab_id to the display/native tool.");
    const tab = matches[0] || await chrome.tabs.create({url, active:false});
    return {tab_id:tab.id, url, status:tab.status, next:"Wait for native_state to succeed; opening a tab does not mean the editor is ready."};
  }
  if (job.kind === "tabs") {
    return tabContext(chrome, current);
  }
  const tab = await resolveTab(job);
  const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN",
    func: job.kind === "display" ? displayCommand : pageCommand, args: [job]});
  if (results.length !== 1 || results[0].result === undefined) throw new Error("Page command failed or tab navigated; inspect state before retrying.");
  return {...results[0].result, tab_id:tab.id};
}

async function connect() {
  const config = await settings();
  if (!config.enabled || !BRIDGE_TOKEN || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const current = new WebSocket(BASE);
  socket = current;
  // The bridge sends a challenge on accept; nothing runs until it proves the token.
  const receive = bridgeSession(current, BRIDGE_TOKEN, {version:chrome.runtime.getManifest().version,
    capabilities:["tab_context_v1", "assembly_sidebar_map_v1", "display_v1", "policy_v2"]});
  current.onmessage = async event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    message = await receive(message);
    if (message?.type === "ready") {
      verified = current;
      refreshBadge();
      clearInterval(heartbeat);
      heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({type: "ping"})); }, 20000);
      return;
    }
    if (message?.type !== "command") return;
    let result;
    if (inFlight) result = {error: "Previous command still running; inspect state before continuing."};
    else {
      inFlight = true;
      try {
        result = await execute(message.job);
        if (JSON.stringify(result).length > 96 * 1024 * 1024 - 1024) result = {error: "Result too large; inspect state and narrow the query."};
      } catch (error) {
        // No request headers, cookies, or stack dumps in bridge errors.
        result = {error: String(error.message || "Page execution failed").slice(0, 500)};
      } finally { inFlight = false; }
    }
    if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({type: "result", id: message.id, result}));
  };
  current.onclose = () => {
    if (socket !== current) return;
    socket = null; clearInterval(heartbeat); refreshBadge();
  };
  current.onerror = () => current.close();
}

chrome.alarms.create("native-reconnect", {periodInMinutes: .5});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "native-reconnect") { connect(); refreshBadge(); } });  // refresh also drops expired requests from the badge
chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.requests) refreshBadge(); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only this extension's popup can manage its connection; no page messaging.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (message.type === "connect") {
    if (socket) socket.close(); socket = null;
    connect().then(() => reply({ok: true})); return true;
  }
  if (message.type === "status") reply({connected: connected()});
  if (message.type === "resolve_request") {
    // The popup's Allow/Deny: the worker is the single writer of "requests", so it deletes the entry.
    chrome.storage.local.get("requests").then(({requests}) => {
      const {[message.id]: _gone, ...rest} = requests ?? {};
      return typeof message.id === "string" ? chrome.storage.local.set({requests: rest}) : null;
    }).then(() => reply({ok: true}));
    return true;
  }
  if (message.type === "disconnect") {
    if (socket) socket.close(); socket = null; clearInterval(heartbeat); reply({ok: true});
  }
});
connect();
