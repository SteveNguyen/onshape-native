import {didFromUrl, docName, docLabel, targetFromUrl} from "./policy.js";
import {ACTIONS, PRESETS, actionOn, applyPreset, bound, branchMode, checkPolicy, createdGrantRevocations, effectivePolicy, presetOf, revokeDocument, setAction, seedFromCreated, setTab, summary, tabMode} from "./grants.js";
import {approve, approveOnce, liveRequests} from "./requests.js";
import {branchNames, tabsFromContents} from "./listings.js";

const $ = id => document.getElementById(id);
const status = $("status"), dot = $("dot"), toggle = $("toggle");
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
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
// All model/Onshape text goes through textContent (el props or text children), never innerHTML.

// This popup writes only "policy" and "approvals"; the worker writes "created", "requests", "consumed".
// ctx: the active Onshape tab {did, wvm, wid, eid, docName, branchName, tabs}; wid/eid are "" off a /w/ URL. Names come only from our own listings.
let ctx = null, branches = {}, listingError = false;
const reasons = new Map();  // request id -> why Allow was refused
const TYPES = {PARTSTUDIO: "Part Studio", ASSEMBLY: "Assembly", DRAWING: "Drawing", BLOB: "File", FEATURESTUDIO: "Feature Studio", VARIABLESTUDIO: "Variables"};
const tabLabel = t => `${t.name || t.eid}${t.type ? ` (${TYPES[t.type] ?? t.type})` : ""}`;
const openTab = () => ctx?.tabs.find(t => t.eid === ctx.eid);

async function load() {
  const s = await chrome.storage.local.get(["policy", "created", "requests", "approvals"]);
  let stored, eff;
  try { stored = checkPolicy(s.policy); } catch { stored = {...checkPolicy(undefined), stale: true, malformed: true}; }
  try { eff = effectivePolicy(s.policy, s.created ?? undefined); } catch { eff = stored.malformed ? checkPolicy(undefined) : stored; }
  // A v1 or malformed policy is replaced by a fresh empty v2 on the first change (base undefined), never on open.
  return {...s, stored, eff, stale: stored.stale === true, base: stored.stale ? undefined : s.policy};
}
// seedDid: a document whose created-only entry must first become a stored entry (keeps its actions).
async function change(fn, seedDid) {
  const s = await load(); const policy = fn(seedDid ? seedFromCreated(s.base, s.created, seedDid) : s.base); delete policy.stale;
  await chrome.storage.local.set({policy});
}
const resolve = id => chrome.runtime.sendMessage({type: "resolve_request", id});
// Narrowing a grant Claude received (created.grants, worker-owned): the worker drops it first (narrow before the
// stored change), so unticking or a preset is never undone by the created grant. eid absent: the whole branch.
async function narrowCreated(eid) {
  const {created} = await chrome.storage.local.get("created");
  for (const message of createdGrantRevocations(created, ctx, eid)) await chrome.runtime.sendMessage(message);
}

// ---- banners ----
function describe(need) {
  // Request fields are untrusted data: non-strings render as "?".
  const str = v => typeof v === "string" ? v : "?";
  const did = str(need.did), eid = str(need.eid), wid = typeof need.wid === "string" ? need.wid.toLowerCase() : null;
  const here = did.toLowerCase() === ctx?.did, mode = String(need.mode ?? "").toUpperCase();
  const tab = here && ctx.tabs.find(t => t.eid === eid.toLowerCase());
  const branch = wid ? (here && (wid === ctx.wid ? ctx.branchName : branches[wid])) || wid : "any branch";
  const where = here ? "" : ` of document ${did}`;
  switch (need.type) {
    case "tab": {
      const name = tab ? `"${tabLabel(tab)}"` : `tab ${eid}`;
      // A branch-free need is granted on the branch the popup shows, so say which.
      if (!wid) return here && ctx.wvm === "w" ? `${mode} ${name} on this branch (${ctx.branchName || ctx.wid})` : `${mode} ${name} in any branch${where} (open this document to approve)`;
      return `${mode} ${name} in ${branch}${where}`;
    }
    case "branch": return `${mode} the whole branch ${branch}${where}`;
    case "branch_write": return `WRITE in branch ${branch}${where} (create a tab)`;
    case "action": return `enable document action "${need.action}"${where}`;
    case "overview": return `list the tabs of document ${did}`;
    default: return `${need.type}${where}`;
  }
}
// Lines describing what a merge/restore does (requests.js describeJob). Request fields are untrusted data:
// only strings and numbers are shown; branch names come from this popup's own listings, never from the request.
function approvalDetails(need, d) {
  if (d === null || typeof d !== "object") return [];
  const str = v => typeof v === "string" ? v : "?";
  const strategy = typeof d.strategy === "string" ? d.strategy : "server default";
  const overrides = `Per-tab strategy overrides: ${Number.isInteger(d.overrides) ? d.overrides : "?"}`;
  if (d.kind === "merge") {
    const id = str(d.id), here = typeof need.did === "string" && need.did.toLowerCase() === ctx?.did;
    const name = here && Object.hasOwn(branches, id.toLowerCase()) ? branches[id.toLowerCase()] : undefined;
    const source = String(d.type).toLowerCase() === "workspace" ? `branch ${name ? `"${name}" (${id})` : id}` : `${str(d.type)} ${id}`;
    return [`Merge from ${source}`, `Default merge strategy: ${strategy}`, overrides];
  }
  if (d.kind === "restore")
    return [`Restore the branch to ${d.vm === "m" ? "microversion" : d.vm === "v" ? "version" : "?"} ${str(d.vmid)}`, `Default restore strategy: ${strategy}`, overrides];
  return [];
}
function banner(s, r) {
  const need = r.need ?? {}, node = el("div", {className: "banner"});
  const deny = el("button", {textContent: "Deny", onclick: () => resolve(r.id)});
  if (need.type === "approval") {
    // Merge/restore: a one-time approval of this exact request, only while the document's merge action is on.
    const live = s.approvals?.[need.key] > Date.now(), ready = typeof need.did === "string" && typeof need.key === "string" && actionOn(s.eff, need.did, "merge");
    node.append(el("div", {textContent: `Claude asks to ${need.critical} (once): ${r.method ?? ""} ${r.path_summary ?? ""} in document ${need.did}`}),
      ...approvalDetails(need, r.details).map(text => el("div", {className: "small", textContent: text})),
      el("div", {className: "muted small", textContent: "Can overwrite others' work. Approval is used once, for this exact request."}));
    if (!ready) node.append(el("div", {className: "warn small", textContent: "Turn on Merge / restore in Document actions first."}));
    node.append(el("div", {className: "row"}, el("button", {textContent: live ? "Approved" : "Approve once", disabled: !ready || live,
      onclick: async () => { const {approvals} = await chrome.storage.local.get("approvals"); await chrome.storage.local.set({approvals: approveOnce(approvals, need.key, Date.now())}); }}), deny));
    return node;
  }
  node.append(el("div", {textContent: `Claude asks to ${describe(need)}`}));
  if (reasons.has(r.id)) node.append(el("div", {className: "warn small", textContent: reasons.get(r.id)}));
  node.append(el("div", {className: "row"}, el("button", {textContent: "Allow", onclick: async () => {
    const s = await load();
    const base = seedFromCreated(s.base, s.created, need.did);  // a created document keeps its actions
    const names = {doc: ctx?.docName, branch: ctx?.branchName, tab: openTab()?.name};
    const res = approve(base, r, {did: ctx?.did, wid: ctx?.wid, eid: ctx?.eid, names});
    if (!res.ok) { reasons.set(r.id, res.reason); return render(); }
    delete res.policy.stale;
    await chrome.storage.local.set({policy: res.policy});  // grant first, then drop the request
    await resolve(r.id);
  }}), deny));
  return node;
}

// ---- sections ----
function renderContext(s) {
  const cur = $("current"), notes = [];
  if (!ctx) return;
  cur.className = "";
  const branch = ctx.wvm === "w" ? (ctx.branchName || ctx.wid) : "";
  cur.replaceChildren(el("div", {className: "title", textContent: ctx.docName || "Untitled"}), el("div", {className: "id", textContent: ctx.did}),
    ...(branch ? [el("div", {className: "title", textContent: `Branch: ${branch}`})] : []),
    ...(ctx.eid ? [el("div", {className: "title", textContent: `Open tab: ${openTab() ? tabLabel(openTab()) : ctx.eid}`})] : []));
  if (ctx.wvm !== "w" && ctx.wvm) notes.push("Grants apply to branches; open a branch to grant access.");
  else if (ctx.wvm === "w" && !ctx.eid) notes.push("Open a tab to use presets.");
  if (listingError) notes.push("Could not load tab names");
  cur.append(...notes.map(n => el("div", {className: "warn small", textContent: n})));
}
function renderPresets(s) {
  const sec = $("presets"); sec.hidden = !(ctx?.wvm === "w" && ctx.eid);
  if (sec.hidden) return;
  const now = presetOf(s.eff, ctx);  // effective grants: a created grant is never hidden behind a preset
  const labels = {tab: `This tab only: read + write ${openTab()?.name || ctx.eid}`, tab_read_rest: "This tab, read the rest of the document (this branch)",
    branch: "Whole document in this branch", custom: "Custom…"};
  sec.replaceChildren(...[...PRESETS, "custom"].map(p => el("label", {}, el("input", {type: "radio", name: "preset", checked: now === p,
    onchange: async () => { if (p === "custom") { $("custom").open = true; return; }
      await narrowCreated(); await change(base => applyPreset(base, ctx, p), ctx.did); }}), labels[p])));
}
function treeRow(s, t) {
  const mode = tabMode(s.eff, ctx.did, ctx.wid, t.eid), whole = branchMode(s.eff, ctx.did, ctx.wid);
  const box = (label, on, locked, set) => el("label", {className: "cb", title: locked ? "Granted by the whole-branch grant" : ""},
    el("input", {type: "checkbox", checked: on, disabled: locked, onchange: async e => {
      const mode = set(e.target.checked);
      await narrowCreated(t.eid); await change(base => setTab(base, ctx, t.eid, mode), ctx.did); }}), label);
  // Write ticks Read; unticking Read clears the tab.
  return el("div", {className: "row trow" + (t.eid === ctx.eid ? " open" : "")}, el("span", {className: "grow title", textContent: tabLabel(t)}),
    box("R", !!mode, !!whole, on => on ? "read" : null), box("W", mode === "write", whole === "write", on => on ? "write" : "read"));
}
function renderTree(s) {
  const sec = $("custom"); sec.hidden = ctx?.wvm !== "w";
  if (sec.hidden) return;
  // Granted tabs missing from the listing (deleted, or the listing failed) stay visible so they can be cleared.
  const tabs = [...ctx.tabs], known = new Set(tabs.map(t => t.eid));
  const granted = s.eff.docs[ctx.did]?.branches[ctx.wid]?.tabs ?? {};  // effective: created grants included
  for (const eid of [...Object.keys(granted), ...(ctx.eid ? [ctx.eid] : [])]) if (!known.has(eid)) { known.add(eid); tabs.push({eid, name: bound(granted[eid]?.name), type: ""}); }
  const folders = new Map();
  for (const t of tabs) folders.set(t.folder ?? "", [...(folders.get(t.folder ?? "") ?? []), t]);
  $("customBody").replaceChildren(...[...folders].flatMap(([folder, rows]) =>
    [...(folder ? [el("div", {className: "folder", textContent: folder})] : []), ...rows.map(t => treeRow(s, t))]));
}
const WARNINGS = {merge: "can overwrite others' work, each run also needs your one-time approval", admin: "share, permissions, public, delete"};
const ACTION_LABELS = {versions: "Create versions", branches: "Create branches", merge: "Merge / restore", tabs: "Create, rename, delete tabs", admin: "Admin"};
function renderActions(s) {
  const sec = $("actions"); sec.hidden = !ctx;
  if (sec.hidden) return;
  $("actionsBody").replaceChildren(...ACTIONS.map(a => el("div", {}, el("label", {}, el("input", {type: "checkbox", checked: actionOn(s.eff, ctx.did, a),
    onchange: e => change(base => setAction(base, ctx.did, a, e.target.checked), ctx.did)}), ACTION_LABELS[a]),
    ...(WARNINGS[a] ? [el("div", {className: "warn small", textContent: WARNINGS[a]})] : []))));
}
function renderAll(s) {
  const items = Object.entries(s.eff.docs).map(([id, entry]) => el("li", {className: "row"},
    el("span", {className: "id grow", textContent: docLabel(id, entry) + (entry.source === "created" ? " (created)" : "")}),
    // Drops the stored entry, and the worker drops the created entry and grants (it owns "created").
    el("button", {textContent: "Revoke", onclick: async () => { await change(base => revokeDocument(base, id)); await chrome.runtime.sendMessage({type: "revoke_created", did: id}); }})));
  $("docs").replaceChildren(...(items.length ? items : [el("li", {className: "muted", textContent: "None. The agent can only list tabs."})]));
}
async function render() {
  const s = await load();
  $("notice").hidden = !s.stale;
  $("notice").textContent = s.stored.malformed ? "Stored access policy is malformed, re-authorize." : "Access model changed, re-authorize.";
  const live = liveRequests(s.requests, Date.now());
  for (const id of reasons.keys()) if (!live.some(r => r.id === id)) reasons.delete(id);
  $("banners").replaceChildren(...live.map(r => banner(s, r)));
  renderContext(s); renderPresets(s); renderTree(s); renderActions(s); renderAll(s);
  // Summary comes from the effective stored grants (created "*" grants included), never from the selected preset.
  $("summarySection").hidden = !ctx;
  if (ctx) $("summary").textContent = summary(s.eff, ctx);
  $("untested").checked = s.eff.allow_untested_native === true;
  $("uifallback").checked = s.eff.allow_ui_fallback === true;
  $("createdocs").checked = s.eff.allow_create_documents === true;
}
for (const [id, key] of [["untested", "allow_untested_native"], ["uifallback", "allow_ui_fallback"], ["createdocs", "allow_create_documents"]])
  $(id).onchange = () => change(base => ({...structuredClone(checkPolicy(base)), [key]: $(id).checked}));

// Listings are user-initiated popup reads (not agent jobs, not policy-checked); only for /w/ URLs.
async function loadListings() {
  if (ctx?.wvm !== "w") return;
  const get = path => fetch(`https://cad.onshape.com/api/v10/documents/d/${ctx.did}/${path}`, {credentials: "include", headers: {Accept: "application/json"}})
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  try {
    const [contents, workspaces] = await Promise.all([get(`w/${ctx.wid}/contents`), get("workspaces")]);
    ctx.tabs = tabsFromContents(contents); branches = branchNames(workspaces); ctx.branchName = branches[ctx.wid] ?? "";
  } catch { listingError = true; }
}
// Context follows the active tab: the side panel stays open across tab and URL changes.
async function setContext() {
  const [active] = await chrome.tabs.query({active: true, currentWindow: true, url: "https://cad.onshape.com/*"});
  const did = didFromUrl(active?.url)?.toLowerCase(), target = targetFromUrl(active?.url), grantable = target?.wvm === "w";
  ctx = did ? {did, wvm: target?.wvm ?? null, wid: grantable ? target.wvmid.toLowerCase() : "", eid: grantable ? (target.eid ?? "").toLowerCase() : "", docName: docName(active.title), branchName: "", tabs: []} : null;
  branches = {}; listingError = false;
  await render();
  $("custom").open = presetOf((await load()).eff, ctx ?? {did: "", wid: "", eid: ""}) === "custom";
  loadListings().then(render);
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.policy || changes.created || changes.requests || changes.approvals)) render(); });
const windowId = (await chrome.windows.getCurrent()).id;
chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId) setContext(); });
chrome.tabs.onUpdated.addListener((id, change, tab) => { if (tab.active && tab.windowId === windowId && change.url) setContext(); });
// sidePanel.open needs the click's user gesture, so it is called without awaiting first.
$("panel").onclick = () => chrome.sidePanel.open({windowId}).then(() => window.close(), () => {});
$("panel").hidden = !chrome.extension.getViews({type: "popup"}).includes(window);  // already in the side panel
await setContext();
await refresh();
setInterval(refresh, 1000);
