import {didFromUrl, docName, docLabel} from "./policy.js";

const status = document.getElementById("status"), dot = document.getElementById("dot"), toggle = document.getElementById("toggle");
const current = document.getElementById("current"), list = document.getElementById("docs"), untested = document.getElementById("untested");
const uiFallback = document.getElementById("uifallback");
async function refresh() {
  const {enabled} = await chrome.storage.local.get("enabled");
  const {connected} = await chrome.runtime.sendMessage({type: "status"});
  status.textContent = connected ? "Connected · :8766" : enabled ? "Waiting for local API" : "Disconnected";
  dot.classList.toggle("on", connected); toggle.textContent = enabled ? "Disconnect" : "Connect";
}
toggle.onclick = async () => {
  const {enabled} = await chrome.storage.local.get("enabled");
  await chrome.storage.local.set({enabled: !enabled});
  await chrome.runtime.sendMessage({type: enabled ? "disconnect" : "connect"}); await refresh();
};

// Only this popup writes "policy"; the worker writes only "created" (documents the
// agent created). Page scripts cannot reach chrome.storage.
async function getState() {
  const {policy, created} = await chrome.storage.local.get(["policy", "created"]);
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  return {policy: plain(policy?.docs) ? policy : {docs: {}, allow_untested_native: false, allow_ui_fallback: false},  // reset malformed
          created: plain(created) ? created : {}};
}
async function update(change) { const state = await getState(); change(state.policy, state.created); await chrome.storage.local.set(state); }
// A revoke must also clear the worker's entry, or the merged policy would keep it.
const revoke = id => update((p, c) => { delete p.docs[id]; delete c[id]; });
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };

// Model text (tab titles) is rendered with textContent only.
async function render() {
  const {policy, created} = await getState();
  const docs = {...created, ...policy.docs};
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true, url: "https://cad.onshape.com/*"});
  const did = didFromUrl(tab?.url);
  if (did) {
    const authorized = Object.hasOwn(docs, did);
    const button = el("button", {textContent: authorized ? "Revoke" : "Authorize this document",
      onclick: () => authorized ? revoke(did) : update(p => {
        const name = docName(tab.title);
        p.docs[did] = {admin: false, source: "user", added: Date.now(), ...(name ? {name} : {})};
      })});
    current.className = "";
    current.replaceChildren(el("div", {className: "title", textContent: tab.title || "Untitled"}), el("div", {className: "id", textContent: did}), button);
  }
  list.replaceChildren(...Object.entries(docs).map(([id, entry]) => el("li", {},
    el("div", {className: "row"}, el("span", {className: "id grow", textContent: docLabel(id, entry) + (entry.source === "created" ? " (created)" : "")}),
      el("button", {textContent: "Revoke", onclick: () => revoke(id)})),
    el("label", {}, el("input", {type: "checkbox", checked: entry.admin === true,
      onchange: event => update((p, c) => { const e = p.docs[id] ?? c[id]; if (e) p.docs[id] = {...e, admin: event.target.checked}; })}),
      "Allow admin actions (share, public, webhooks, delete)"))));
  if (!list.children.length) list.append(el("li", {className: "muted", textContent: "None. The agent can only list tabs."}));
  untested.checked = policy.allow_untested_native === true;
  uiFallback.checked = policy.allow_ui_fallback === true;
}
untested.onchange = () => update(p => { p.allow_untested_native = untested.checked; });
uiFallback.onchange = () => update(p => { p.allow_ui_fallback = uiFallback.checked; });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.policy || changes.created)) render(); });
await render();
await refresh();
setInterval(refresh, 1000);
