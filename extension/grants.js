// v2 policy model: per-tab, per-branch grants. Pure: the worker loads the popup-managed
// policy and the worker-written "created" map and passes them in. Names are display-only.

export const ACTIONS = ["versions", "branches", "merge", "tabs", "admin"];
const HEX = /^[0-9a-f]{24}$/i;
const MODES = ["read", "write"];
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = () => ({version: 2, docs: {}, allow_untested_native: false, allow_ui_fallback: false, allow_create_documents: false});
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
  for (const k of ["allow_untested_native", "allow_ui_fallback", "allow_create_documents"]) if (policy[k] !== undefined && typeof policy[k] !== "boolean") throw malformed("document");
  return {...policy, allow_untested_native: policy.allow_untested_native === true, allow_ui_fallback: policy.allow_ui_fallback === true,
          allow_create_documents: policy.allow_create_documents === true,
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
    if (!docs[did]) { docs[did] = entry; continue; }
    // Popup entry wins for actions; the created entry's branches (incl. "*") are unioned in, never dropped.
    docs[did] = {...docs[did], branches: structuredClone(docs[did].branches)};
    unionBranches(docs[did].branches, structuredClone(entry.branches));
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
export const bound = t => typeof t === "string" ? t.trim().slice(0, 120) : "";

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

export const hasAnyGrant = (policy, did) =>
  Object.values(branchesOf(policy, did)).some(b => b.all || Object.keys(b.tabs ?? {}).length > 0);

export const actionOn = (policy, did, action) => policy.docs?.[did?.toLowerCase()]?.actions?.[action] === true;

// ---- popup model (pure; the popup is a thin DOM layer over these) ----
// ctx = {did, wid, eid, docName, branchName, tabs: [{eid, name, type, folder?}]}; names are display-only.

export const PRESETS = ["tab_read", "tab", "tab_read_rest", "branch"];
const noActions = () => Object.fromEntries(ACTIONS.map(a => [a, false]));
const tabName = (ctx, eid) => bound(ctx.tabs?.find(t => t?.eid?.toLowerCase() === eid)?.name);

// Clone with the doc entry (and, if asked, the branch) present; new entries are user-sourced, all actions off.
function withEntry(policy, ctx) {
  const p = structuredClone(checkPolicy(policy));
  const did = ctx.did.toLowerCase();
  const entry = p.docs[did] ??= {added: Date.now(), source: "user", actions: noActions(), branches: {}};
  if (!entry.name && bound(ctx.docName)) entry.name = bound(ctx.docName);
  return {p, did, entry, wid: ctx.wid.toLowerCase()};
}

// Replaces only branches[wid] of this document; actions and other branches stay.
export function applyPreset(policy, ctx, preset) {
  if (!PRESETS.includes(preset)) throw new Error("applyPreset: unknown preset");
  const eid = ctx.eid.toLowerCase();
  const {p, entry, wid} = withEntry(policy, ctx);
  const name = entry.branches[wid]?.name ?? (bound(ctx.branchName) || undefined);
  const mine = {mode: preset === "tab_read" ? "read" : "write", ...(tabName(ctx, eid) && {name: tabName(ctx, eid)})};
  const b = preset === "branch" ? {all: "write", tabs: {}} : {...(preset === "tab_read_rest" && {all: "read"}), tabs: {[eid]: mine}};
  entry.branches[wid] = name ? {name, ...b} : b;
  return p;
}

// Sets the exact mode on one tab (may lower write to read); null removes it and prunes empty branch/doc entries.
export function setTab(policy, ctx, eid, mode, now = Date.now()) {
  eid = eid.toLowerCase();
  if (mode !== null) {
    const base = structuredClone(checkPolicy(policy));
    delete base.docs[ctx.did.toLowerCase()]?.branches[ctx.wid.toLowerCase()]?.tabs[eid]; // grantTab only raises
    const isNew = !base.docs[ctx.did.toLowerCase()];
    const p = grantTab(base, ctx.did, ctx.wid, eid, mode, {doc: ctx.docName, branch: ctx.branchName, tab: tabName(ctx, eid)});
    if (isNew) Object.assign(p.docs[ctx.did.toLowerCase()], {added: now, source: "user"});
    return p;
  }
  const p = structuredClone(checkPolicy(policy));
  const did = ctx.did.toLowerCase(), wid = ctx.wid.toLowerCase();
  const entry = p.docs[did], b = entry?.branches[wid];
  if (!b) return p;
  delete b.tabs[eid];
  if (!b.all && !Object.keys(b.tabs).length) delete entry.branches[wid];
  if (!Object.keys(entry.branches).length && !ACTIONS.some(a => entry.actions[a])) delete p.docs[did];
  return p;
}

// "Add this tab": raises the open tab to `mode`, never lowers it and never touches other grants (unlike a preset).
export function addTab(policy, ctx, mode, now = Date.now()) {
  if (!MODES.includes(mode)) throw new Error("addTab: invalid mode");
  const current = tabMode(policy, ctx.did, ctx.wid, ctx.eid);
  if (max(current, mode) === current) return structuredClone(checkPolicy(policy));  // already at least `mode` (tab or whole branch)
  return setTab(policy, ctx, ctx.eid, mode, now);
}

export function setAction(policy, did, action, on) {
  if (!ACTIONS.includes(action) || typeof on !== "boolean") throw new Error("setAction: invalid action");
  const p = structuredClone(checkPolicy(policy));
  const entry = p.docs[did.toLowerCase()] ??= {added: Date.now(), source: "user", actions: noActions(), branches: {}};
  entry.actions[action] = on;
  return p;
}

// Before a popup change on a document that exists only in `created`: gives it a stored entry carrying the
// created entry's actions (admin stays off), so the new entry does not switch the other actions off.
export function seedFromCreated(policy, created, did) {
  const p = structuredClone(checkPolicy(policy));
  const id = typeof did === "string" ? did.toLowerCase() : "";
  const made = plain(created?.docs) ? created.docs[id] : undefined;
  if (!plain(made) || p.docs[id]) return p;
  const actions = Object.fromEntries(ACTIONS.map(a => [a, a !== "admin" && made.actions?.[a] === true]));
  p.docs[id] = {added: typeof made.added === "number" ? made.added : Date.now(), source: "created", ...(optName(made.name) && made.name && {name: made.name}), actions, branches: {}};
  return p;
}

export function revokeDocument(policy, did) {
  const p = structuredClone(checkPolicy(policy));
  delete p.docs[did.toLowerCase()];
  return p;
}

// Which preset the EFFECTIVE grants of this branch match exactly (names ignored); nothing granted is "none".
// Takes the effectivePolicy output (stored + created docs + created grants), so a grant Claude received is never
// hidden behind a preset; a "*" branch (created document) is not a preset: "custom".
export function presetOf(policy, ctx) {
  const all = branchesOf(plain(policy?.docs) && policy.version === 2 ? policy : checkPolicy(policy), ctx.did);
  if (all["*"]) return "custom";
  const b = all[ctx.wid.toLowerCase()];
  const eids = Object.keys(b?.tabs ?? {});
  if (!b || (!b.all && !eids.length)) return "none";
  const only = eids.length === 1 && eids[0] === ctx.eid.toLowerCase();
  const mine = only && b.tabs[eids[0]].mode === "write";
  if (b.all === "write" && !eids.length) return "branch";
  if (only && !b.all && b.tabs[eids[0]].mode === "read") return "tab_read";
  if (mine && !b.all) return "tab";
  if (mine && b.all === "read") return "tab_read_rest";
  return "custom";
}

// ---- created grants (worker-owned "created.grants") narrowed from the popup ----
// The popup cannot write "created", so it asks the worker to drop the created grant a change would otherwise
// leave behind: a tab change (eid) drops that tab's created grant, a preset (no eid) the whole created branch entry.
const keyOf = (obj, id) => plain(obj) ? Object.keys(obj).find(k => k.toLowerCase() === id) : undefined;
export function createdGrantRevocations(created, ctx, eid) {
  const did = ctx.did.toLowerCase(), wid = ctx.wid.toLowerCase();
  const g = plain(created?.grants) ? created.grants[keyOf(created.grants, did)] : undefined;
  const b = plain(g?.branches) ? g.branches[keyOf(g.branches, wid)] : undefined;
  if (!plain(b)) return [];
  if (eid === undefined) return [{type: "revoke_created_grant", did, wid}];
  const e = eid.toLowerCase();
  return keyOf(b.tabs, e) !== undefined ? [{type: "revoke_created_grant", did, wid, eid: e}] : [];
}

// Worker side: the created map without that tab's grant (or the whole branch entry when eid is absent);
// empty branches and documents are pruned. Pure; returns the same object when there is nothing to drop.
export function revokeCreatedGrant(created, did, wid, eid) {
  const id = v => typeof v === "string" && HEX.test(v);
  if (!id(did) || !id(wid) || (eid !== undefined && !id(eid))) throw new Error("revokeCreatedGrant: invalid id");
  const dk = plain(created) ? keyOf(created.grants, did.toLowerCase()) : undefined;
  const wk = dk !== undefined ? keyOf(created.grants[dk]?.branches, wid.toLowerCase()) : undefined;
  if (wk === undefined) return created;
  const out = structuredClone(created), branches = out.grants[dk].branches;
  if (eid === undefined) delete branches[wk];
  else {
    const b = branches[wk], ek = plain(b) ? keyOf(b.tabs, eid.toLowerCase()) : undefined;
    if (ek === undefined) return created;
    delete b.tabs[ek];
    if (!b.all && !Object.keys(b.tabs).length) delete branches[wk];
  }
  if (!Object.keys(branches).length) delete out.grants[dk];
  return out;
}

// Plain-language account of the stored (effective) grants; must never under-state access.
export function summary(policy, ctx) {
  // Already-normalized effective policy (may hold "*"), so no checkPolicy here.
  const p = policy ?? empty(), did = ctx.did.toLowerCase(), wid = ctx.wid.toLowerCase();
  const all = branchesOf(p, did), star = all["*"], here = all[wid];
  const on = ACTIONS.filter(a => actionOn(p, did, a));
  const acts = on.filter(a => a !== "admin");
  const tail = [];
  if (acts.length) tail.push(`Document actions on: ${acts.join(", ")}.`);
  if (on.includes("admin")) tail.push("Admin actions are ON.");
  // The worker cannot see what a page control does: say that clicks escape every grant.
  if (p.allow_ui_fallback === true) tail.push("Advanced: UI fallback clicks are ON — clicks in an open document are not limited to granted tabs, branches or document actions.");
  if (p.allow_untested_native === true) tail.push("Advanced: untested native commands are ON.");
  if (p.allow_create_documents === true) tail.push("Advanced: creating new documents is ON.");
  const others = Object.entries(all).filter(([w, b]) => w !== wid && w !== "*" && (b.all || Object.keys(b.tabs ?? {}).length));
  if (others.length) tail.push(`+ ${others.length} other branch${others.length > 1 ? "es" : ""} with grants.`);
  if (!hasAnyGrant(p, did)) {
    return tail.length ? ["Claude has no tab access in this document.", ...tail].join(" ") : "Claude has no access to this document.";
  }
  // This branch plus the "*" wildcard: tabs take the max mode, whole-branch the max of both.
  const mm = {}; for (const b of [here, star]) if (b) unionBranches(mm, {m: b});
  const m = mm.m ?? {tabs: {}};
  // Names are Onshape text: quote them (inner quotes and control chars neutralized) so they cannot forge sentences.
  const q = n => { const c = bound(n).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").replace(/"/g, "\u2019").trim(); return c && `"${c}"`; };
  // Classify by EFFECTIVE mode (tab, whole branch, "*"), like tabMode.
  const names = mode => Object.entries(m.tabs).filter(([, t]) => max(t.mode, m.all) === mode).map(([e]) => q(tabName(ctx, e)) || q(m.tabs[e].name) || e);
  const bn = q(ctx.branchName) || wid;
  const scope = star ? "all branches" : `branch ${bn}`;
  const whole = star ? "the whole document in all branches" : `the whole branch ${bn}`;
  const write = names("write"), read = names("read");
  const out = [];
  if (!write.length && m.all !== "write") {
    const items = [...read, ...(m.all === "read" ? [whole] : [])];
    out.push(items.length ? `Claude can read ${items.join(" and ")}${m.all === "read" ? "" : ` in ${scope}`}.` : `Claude has no access in ${scope}.`);
  } else {
    const items = [...write, ...(m.all === "write" ? [whole] : [])];
    out.push(`Claude can read and edit ${items.join(", ")}${m.all === "write" ? "" : ` in ${scope}`}.`);
    if (read.length) out.push(`Read only: ${read.join(", ")}.`);
    if (m.all === "read") out.push(`Read: the rest of this ${star ? "document" : "branch"}.`);
  }
  out.push(...tail);
  if (!tail.length) out.push("Nothing else.");
  return out.join(" ");
}
