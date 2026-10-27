// Access requests and one-shot approvals. Pure: the worker files requests (it owns "requests"),
// only the popup turns one into a grant or approval, and only by exactly the requested need.
// A request is data from a refused agent call: approve() re-validates it and never trusts more than the need.
import {ACTIONS, bound, checkPolicy, grantTab, hasAnyGrant} from "./grants.js";

const HEX = /^[0-9a-f]{24}$/i;
const MODES = ["read", "write"];
const TTL = 3_600_000, MAX = 20, APPROVAL_TTL = 300_000;
// admin and merge are enabled deliberately in the popup, never by a banner.
const APPROVABLE_ACTIONS = new Set(["versions", "branches", "tabs"]);
const OPEN_FIRST = "Open this document first, then approve.";
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const newEntry = () => ({actions: Object.fromEntries(ACTIONS.map(a => [a, false])), branches: {}});

// Sorted-key JSON: the same need always has the same id.
const stable = v => plain(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

// {method, path_summary} for an approval request: the path only (no query, no body), shown to the user.
export const describeJob = job => ({method: String(job?.method ?? "").slice(0, 10), path_summary: String(job?.path ?? "").split("?")[0].slice(0, 200)});

const live = (requests, now) => Object.values(plain(requests) ? requests : {}).filter(r => plain(r) && r.last_seen >= now - TTL);

// requests: {[id]: {id, need, first_seen, last_seen, count, method?, path_summary?}}.
export function fileRequest(requests, need, now, describe) {
  if (!plain(need) || (need.type === "action" && !APPROVABLE_ACTIONS.has(need.action))) return requests;
  const id = stable(need);
  const kept = live(requests, now).sort((a, b) => b.last_seen - a.last_seen);
  const old = kept.find(r => r.id === id);
  const entry = old ? {...old, count: old.count + 1, last_seen: now}
    : {id, need, first_seen: now, last_seen: now, count: 1,
       ...(need.type === "approval" && plain(describe) ? {method: describe.method, path_summary: describe.path_summary} : {})};
  const rest = kept.filter(r => r.id !== id);
  return Object.fromEntries([entry, ...rest].sort((a, b) => b.last_seen - a.last_seen).slice(0, MAX).map(r => [r.id, r]));
}

export const liveRequests = (requests, now) => live(requests, now).sort((a, b) => b.last_seen - a.last_seen);

// Popup Allow. Returns {policy, ok, reason?}: on ok the policy has exactly the need added; otherwise the
// SAME policy object comes back with a reason. ctx = {did, wid, eid?, names?: {doc, branch, tab}} is the
// document/branch the popup shows (from the browser tab URL); names are display-only and bounded.
export function approve(policy, request, ctx) {
  const no = reason => ({policy, ok: false, reason});
  const need = request?.need;
  if (!plain(need) || !HEX.test(need.did ?? "")) return no("Malformed request.");
  if (typeof need.did !== "string" || [need.wid, need.eid].some(v => v != null && typeof v !== "string")) return no("Malformed request.");
  const did = need.did.toLowerCase();
  const here = typeof ctx?.did === "string" && ctx.did.toLowerCase() === did;
  // No blind cross-document approvals: a document with no grant at all is approved only while it is open.
  let p;
  try { p = checkPolicy(policy); } catch (e) { return no(e.message); }
  if (!hasAnyGrant(p, did) && !here) return no(OPEN_FIRST);
  const ctxWid = typeof ctx?.wid === "string" && HEX.test(ctx.wid) ? ctx.wid.toLowerCase() : null;
  // Names only for the document/branch/tab the popup actually shows.
  const names = here ? {doc: ctx.names?.doc, branch: ctxWid && ctxWid === need.wid?.toLowerCase?.() ? ctx.names?.branch : undefined,
                        tab: ctx.eid && ctx.eid === need.eid ? ctx.names?.tab : undefined} : {};

  if (need.type === "tab") {
    if (!MODES.includes(need.mode) || !HEX.test(need.eid ?? "")) return no("Malformed request.");
    // A branch-free read (wid null) is granted on the branch the user is viewing.
    const wid = need.wid ?? (here ? ctxWid : null);
    if (!wid || !HEX.test(wid)) return no(OPEN_FIRST);
    if (need.wid && !HEX.test(need.wid)) return no("Malformed request.");
    return {policy: grantTab(policy, did, wid, need.eid, need.mode, names), ok: true};
  }
  if (need.type === "branch") {
    if (!MODES.includes(need.mode) || !HEX.test(need.wid ?? "")) return no("Malformed request.");
    if (!here || ctxWid !== need.wid.toLowerCase()) return no(OPEN_FIRST);
    const q = structuredClone(p);
    const entry = q.docs[did] ??= newEntry();
    const branch = entry.branches[ctxWid] ??= {tabs: {}};
    branch.all = branch.all === "write" || need.mode === "write" ? "write" : "read";
    if (bound(names.doc)) entry.name = bound(names.doc);
    if (bound(names.branch)) branch.name = bound(names.branch);
    return {policy: q, ok: true};
  }
  if (need.type === "action") {
    if (!APPROVABLE_ACTIONS.has(need.action)) return no("This action is enabled deliberately in Document actions, not from a request.");
    const q = structuredClone(p);
    const entry = q.docs[did] ??= newEntry();
    entry.actions[need.action] = true;
    return {policy: q, ok: true};
  }
  if (need.type === "branch_write") return no("Grant write on a tab of this branch (or the whole branch) in the popup.");
  if (need.type === "overview") return no("Grant a tab of this document in the popup.");
  if (need.type === "approval") return no("Approve this exact request once with the approval button.");
  return no("Unknown request type.");
}

// One popup approval for one exact job key; the worker consumes it on first use.
// The expiry always differs from a consumed approval's (consumed[key] === the approval it used), so approving again works.
export const approveOnce = (approvals, key, now) => {
  const old = plain(approvals) && typeof approvals[key] === "number" ? approvals[key] : 0;
  return {...(plain(approvals) ? approvals : {}), [key]: Math.max(now + APPROVAL_TTL, old + 1)};
};

// Drops expired approvals, and consumed entries with no live approval or for an older approval of the key.
// `consumed` is {jobKey: expiry of the approval it consumed}. Returns {approvals, consumed}.
export function pruneApprovals(approvals, consumed, now) {
  const kept = Object.fromEntries(Object.entries(plain(approvals) ? approvals : {}).filter(([, exp]) => typeof exp === "number" && exp > now));
  return {approvals: kept, consumed: Object.fromEntries(Object.entries(plain(consumed) ? consumed : {}).filter(([k, exp]) => kept[k] === exp))};
}

// Badge for the action icon: live request count (orange) wins over the connection state.
export function badgeFor(requests, now, connected) {
  const n = live(requests, now).length;
  return n > 0 ? {text: String(n), color: "#d97706"} : {text: connected ? "ON" : "OFF"};
}
