import {pageCommand} from "./page-adapter.js";
import {restGet} from "./rest-get.js";
import {tabContext} from "./tab-context.js";
import {displayCommand} from "./display-adapter.js";
import {BRIDGE_TOKEN} from "./local-config.js";
import {badgeFor} from "./requests.js";
import {execute as executePipeline, fromPopup, popupStorageMessage} from "./execute.js";
import {bridgeSession} from "./handshake.js";

let socket = null;
let heartbeat = null;
let verified = null;  // the socket whose bridge proved the token
let inFlight = false;
let probing = false;
const BASE = "ws://127.0.0.1:8766/extension";
const HEALTH = "http://127.0.0.1:8766/health";

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

const connected = () => !!socket && verified === socket && socket.readyState === WebSocket.OPEN;

// Live request count (orange) wins over ON/OFF; the popup's Allow/Deny changes "requests" in storage.
async function refreshBadge() {
  const {requests} = await chrome.storage.local.get("requests");
  const badge = badgeFor(requests, Date.now(), connected());
  chrome.action.setBadgeText({text: badge.text});
  chrome.action.setBadgeBackgroundColor({color: badge.color ?? "#4b5563"});
}

// Authorize, file requests, consume approvals, run, record created objects: see execute.js (tested there).
// The worker writes only "created", "requests", "consumed", never the popup's "policy"/"approvals".
const execute = job => executePipeline(job, {storage: chrome.storage.local, run, refreshBadge});

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
  if (!config.enabled || !BRIDGE_TOKEN || probing || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  // Chrome logs every refused WebSocket on the extension Errors page, so probe first: a refused fetch is a
  // catchable rejection. Any HTTP answer means a bridge is listening (the unsigned probe gets 401).
  probing = true;
  try { await fetch(HEALTH, {cache: "no-store"}); } catch { return; } finally { probing = false; }
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
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
  if (!fromPopup(sender, chrome.runtime)) return;
  if (message.type === "connect") {
    if (socket) socket.close(); socket = null;
    connect().then(() => reply({ok: true})); return true;
  }
  if (message.type === "status") reply({connected: connected()});
  // resolve_request, revoke_created, revoke_created_grant: worker-owned storage (execute.js).
  const pending = popupStorageMessage(message, sender, {storage: chrome.storage.local, runtime: chrome.runtime});
  if (pending) { pending.then(() => reply({ok: true})); return true; }
  if (message.type === "disconnect") {
    if (socket) socket.close(); socket = null; clearInterval(heartbeat); reply({ok: true});
  }
});
connect();
