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
function checkEntry(entry, what) {
  if (!plain(entry) || !optName(entry.name) || !plain(entry.branches ?? {}) || !plain(entry.actions ?? {})) throw malformed(what);
  const actions = {};
  for (const a of ACTIONS) {
    const v = entry.actions?.[a];
    if (v !== undefined && typeof v !== "boolean") throw malformed(what);
    actions[a] = v === true;
  }
  const branches = {};
  for (const [wid, b] of Object.entries(entry.branches ?? {})) {
    if (!(wid === "*" || HEX.test(wid)) || !plain(b) || !optName(b.name) || !plain(b.tabs ?? {}) ||
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

function checkDocs(docs, what) {
  if (!plain(docs)) throw malformed(what);
  const out = {};
  for (const [did, entry] of Object.entries(docs)) {
    if (!HEX.test(did)) throw malformed(what);
    out[did.toLowerCase()] = checkEntry(entry, what);
  }
  return out;
}

// Missing policy means nothing is authorized; a v1 policy is dropped (stale); a malformed v2 refuses everything.
export function checkPolicy(policy) {
  if (policy === undefined) return empty();
  if (plain(policy) && policy.version !== 2) return {...empty(), stale: true};
  if (!plain(policy)) throw malformed("document");
  return {...policy, docs: checkDocs(policy.docs, "document")};
}

// Adds the grants of `from` into `into` (both normalized branch maps): tabs and `all` take the max mode.
function unionBranches(into, from) {
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
  // Worker-created docs the popup has no entry for.
  for (const [did, entry] of Object.entries(created.docs === undefined ? {} : checkDocs(created.docs, "created-document"))) docs[did] ??= entry;
  for (const [did, g] of Object.entries(created.grants === undefined ? {} : checkDocs(created.grants, "created-document"))) {
    // Copy so the caller's policy is never mutated.
    docs[did] = {...(docs[did] ?? g), branches: structuredClone(docs[did]?.branches ?? {})};
    unionBranches(docs[did].branches, g.branches);
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

export const hasAnyGrant = (policy, did) =>
  Object.values(branchesOf(policy, did)).some(b => b.all || Object.keys(b.tabs ?? {}).length > 0);

export const actionOn = (policy, did, action) => policy.docs?.[did?.toLowerCase()]?.actions?.[action] === true;
