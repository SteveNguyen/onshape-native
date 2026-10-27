// v2 policy model: per-tab, per-branch grants. Pure: the worker loads the popup-managed
// policy and the worker-written "created" map and passes them in. Names are display-only.

export const ACTIONS = ["versions", "branches", "merge", "tabs", "admin"];
const HEX = /^[0-9a-f]{24}$/i;
const MODES = ["read", "write"];
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = () => ({version: 2, docs: {}, allow_untested_native: false, allow_ui_fallback: false});
const malformed = what => new Error(`Extension ${what} policy is malformed; ask the user to re-authorize in the Onshape Native popup.`);
// Write implies read.
const max = (a, b) => a === "write" || b === "write" ? "write" : a ?? b ?? null;
const optName = n => n === undefined || typeof n === "string";

// Validates one doc entry and returns a normalized copy (lower-cased ids, all actions present).
// `star` allows the "*" all-branches key, which only worker-created documents may carry.
function checkEntry(entry, what, star = false) {
  if (!plain(entry) || !optName(entry.name) || !plain(entry.branches ?? {}) || !plain(entry.actions ?? {})) throw malformed(what);
  const actions = {};
  for (const a of ACTIONS) {
    const v = entry.actions?.[a];
    if (v !== undefined && typeof v !== "boolean") throw malformed(what);
    actions[a] = v === true;
  }
  const branches = {};
  for (const [wid, b] of Object.entries(entry.branches ?? {})) {
    if (!((star && wid === "*") || HEX.test(wid)) || !plain(b) || !optName(b.name) || !plain(b.tabs ?? {}) ||
        (b.all !== undefined && !MODES.includes(b.all))) throw malformed(what);
    const tabs = {};
    for (const [eid, t] of Object.entries(b.tabs ?? {})) {
      if (!HEX.test(eid) || !plain(t) || !MODES.includes(t.mode) || !optName(t.name)) throw malformed(what);
      tabs[eid.toLowerCase()] = {...t};
    }
    branches[wid.toLowerCase()] = {...b, tabs};
  }
  return {...entry, actions, branches};
}

function checkDocs(docs, what, star = false) {
  if (!plain(docs)) throw malformed(what);
  const out = {};
  for (const [did, entry] of Object.entries(docs)) {
    if (!HEX.test(did)) throw malformed(what);
    out[did.toLowerCase()] = checkEntry(entry, what, star);
  }
  return out;
}

// Missing policy means nothing is authorized; a v1 policy is dropped (stale); a malformed v2 refuses everything.
export function checkPolicy(policy) {
  if (policy === undefined) return empty();
  if (plain(policy) && policy.version !== 2) return {...empty(), stale: true};
  if (!plain(policy)) throw malformed("document");
  for (const k of ["allow_untested_native", "allow_ui_fallback"]) if (policy[k] !== undefined && typeof policy[k] !== "boolean") throw malformed("document");
  return {...policy, allow_untested_native: policy.allow_untested_native === true, allow_ui_fallback: policy.allow_ui_fallback === true,
          docs: checkDocs(policy.docs, "document")};
}

// Adds the grants of `from` into `into` (both normalized branch maps): tabs and `all` take the max mode.
export function unionBranches(into, from) {
  for (const [wid, b] of Object.entries(from)) {
    const cur = into[wid] ??= {tabs: {}};
    if (b.name && !cur.name) cur.name = b.name;
    if (b.all) cur.all = max(cur.all, b.all);
    for (const [eid, t] of Object.entries(b.tabs)) {
      cur.tabs[eid] = {...cur.tabs[eid], ...t, mode: max(cur.tabs[eid]?.mode, t.mode)};
    }
  }
}

// The popup writes "policy" and the worker writes only "created" ({docs, grants}), so neither
// overwrites the other. Popup entries win for actions; grants are unioned. Old flat v1 maps are ignored.
export function effectivePolicy(policy, created = {}) {
  const base = checkPolicy(policy);
  if (!plain(created)) throw malformed("created-document");
  const docs = {...base.docs};
  // Worker-created docs the popup has no entry for; never admin.
  const made = created.docs === undefined ? {} : checkDocs(created.docs, "created-document", true);
  for (const [did, entry] of Object.entries(made)) {
    if (entry.actions.admin) throw malformed("created-document");
    docs[did] ??= entry;
  }
  // Grants contribute branches/tabs only (never actions, never "*") and only to known documents.
  if (created.grants !== undefined && !plain(created.grants)) throw malformed("created-document");
  for (const [did, g] of Object.entries(created.grants ?? {})) {
    if (!plain(g)) throw malformed("created-document");
    const {branches} = checkDocs({[did]: {branches: g.branches}}, "created-document")[did.toLowerCase()];
    const id = did.toLowerCase();
    if (!docs[id]) continue;
    // Copy so the caller's policy is never mutated.
    docs[id] = {...docs[id], branches: structuredClone(docs[id].branches)};
    unionBranches(docs[id].branches, branches);
  }
  return {...base, docs};
}

const branchesOf = (policy, did) => policy.docs?.[did?.toLowerCase()]?.branches ?? {};

// Whole-branch mode for one branch, or via the "*" (created documents) wildcard.
export function branchMode(policy, did, wid) {
  const b = branchesOf(policy, did);
  return max(b[wid?.toLowerCase()]?.all, b["*"]?.all);
}

export function tabMode(policy, did, wid, eid) {
  const b = branchesOf(policy, did);
  return max(b[wid?.toLowerCase()]?.tabs?.[eid?.toLowerCase()]?.mode, branchMode(policy, did, wid));
}

// Strongest mode on a tab over every branch (history and references are branch-independent reads).
export function anyBranchMode(policy, did, eid) {
  let mode = null;
  for (const b of Object.values(branchesOf(policy, did))) mode = max(mode, max(b.tabs?.[eid?.toLowerCase()]?.mode, b.all));
  return mode;
}

// Some write in one branch (whole branch, "*", or one tab): creating a tab there needs it.
export function branchHasWrite(policy, did, wid) {
  const tabs = branchesOf(policy, did)[wid?.toLowerCase()]?.tabs ?? {};
  return branchMode(policy, did, wid) === "write" || Object.values(tabs).some(t => t?.mode === "write");
}

// Same bound as docName in policy.js (not imported: policy.js imports this file). Display-only.
const bound = t => typeof t === "string" ? t.trim().slice(0, 120) : "";

// Grants `mode` on one tab of one branch (popup-side, pure). Creates the doc entry (all actions off),
// never downgrades an existing tab mode, and sets optional display names {doc, branch, tab}.
export function grantTab(policy, did, wid, eid, mode, names = {}) {
  if (!MODES.includes(mode) || !HEX.test(did) || !HEX.test(wid) || !HEX.test(eid)) throw new Error("grantTab: invalid id or mode");
  const p = structuredClone(checkPolicy(policy));
  const entry = p.docs[did.toLowerCase()] ??= {actions: Object.fromEntries(ACTIONS.map(a => [a, false])), branches: {}};
  const branch = entry.branches[wid.toLowerCase()] ??= {tabs: {}};
  const tab = branch.tabs[eid.toLowerCase()] = {...branch.tabs[eid.toLowerCase()], mode: max(branch.tabs[eid.toLowerCase()]?.mode, mode)};
  for (const [target, key] of [[entry, "doc"], [branch, "branch"], [tab, "tab"]]) if (bound(names?.[key])) target.name = bound(names[key]);
  return p;
}

export const hasAnyGrant =(policy, did) =>
  Object.values(branchesOf(policy, did)).some(b => b.all || Object.keys(b.tabs ?? {}).length > 0);

export const actionOn = (policy, did, action) => policy.docs?.[did?.toLowerCase()]?.actions?.[action] === true;
