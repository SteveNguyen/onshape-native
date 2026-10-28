// The worker's command pipeline and popup storage messages, with storage and the page runner injected so they
// are testable without a browser. `storage` is chrome.storage.local (get(keys) / set(items), both promises).
// The worker writes only "created", "requests", "consumed", "rate"; the popup writes "policy", "approvals", "rate_limits".
import {AccessError, authorize, applyPolicy, effectivePolicy, recordCreated} from "./policy.js";
import {describeJob, fileRequest, pruneApprovals} from "./requests.js";
import {revokeCreatedGrant} from "./grants.js";
import {check as checkRate, record as recordRate} from "./rate-guard.js";

const stored = storage => storage.get(["policy", "created", "requests", "approvals", "consumed"]);

// A refused agent call becomes a popup request for exactly the missing need. Never masks the refusal.
export async function fileAccessRequest(storage, job, error, refreshBadge = async () => {}) {
  try {
    const now = Date.now();
    const {requests} = await storage.get("requests");
    const need = error.need;
    await storage.set({requests: fileRequest(requests, need, now, need?.type === "approval" ? describeJob(job) : undefined)});
    await refreshBadge();
  } catch { /* the bridge still gets the original error */ }
}

// deps: {storage, run(job, current) -> result, refreshBadge?, sleep?(ms)}.
export async function execute(job, {storage, run, refreshBadge, sleep = ms => new Promise(r => setTimeout(r, ms))}) {
  // The popup-managed policy is authoritative; bridge-supplied trust fields are overwritten.
  const {policy, created, approvals: rawApprovals, consumed: rawConsumed} = await stored(storage);
  const current = effectivePolicy(policy, created);
  const now = Date.now();
  const {approvals, consumed} = pruneApprovals(rawApprovals, rawConsumed, now);
  const original = job;
  let approvalKey;
  try {
    ({approvalKey} = authorize(job, current, approvals, consumed, now));
    job = applyPolicy(job, current, approvals, consumed, now);
  } catch (error) {
    if (error instanceof AccessError) await fileAccessRequest(storage, original, error, refreshBadge);
    throw error;
  }
  // Consume the one-shot approval BEFORE running: a failed write means no run, and any retry needs a new approval.
  // The expiry comes from the snapshot authorize used, so a re-approval made mid-run is not wasted.
  if (approvalKey) {
    const latest = await stored(storage);
    const kept = pruneApprovals(latest.approvals, latest.consumed, Date.now()).consumed;
    await storage.set({consumed: {...kept, [approvalKey]: approvals[approvalKey]}});
  }
  // Rate guard: refuse before sending when Onshape asked us to wait or our caps are reached, then count the call.
  const {rate, rate_limits} = await storage.get(["rate", "rate_limits"]);
  const wait = checkRate(rate, job, Date.now(), rate_limits);
  if (wait > 0) await sleep(Math.min(wait, 10000));
  let result;
  try { result = await run(job, current); }
  catch (error) { if (job.kind === "rest") await storage.set({rate: recordRate(rate, job, null, Date.now())}); throw error; }
  if (job.kind === "rest") await storage.set({rate: recordRate(rate, job, result, Date.now())});
  // Re-read so a concurrent popup change is kept; commands are already serialized by the worker's inFlight.
  if (job.kind === "rest" && job.method !== "GET") {
    const latest = await stored(storage);
    const updated = recordCreated(job, result, latest.policy, latest.created);
    if (updated) await storage.set({created: updated});
  }
  return result;
}

// Only this extension's popup page may manage requests and "created"; no page or content-script messaging.
export const fromPopup = (sender, runtime) => !!sender && sender.id === runtime.id && sender.url === runtime.getURL("popup.html");

// Popup messages that change worker-owned storage. Returns a promise (reply when settled), or null when the
// sender is not the popup or the message is not one of these.
export function popupStorageMessage(message, sender, {storage, runtime}) {
  if (!fromPopup(sender, runtime)) return null;
  if (message?.type === "resolve_request") {
    // The popup's Allow/Deny: the worker is the single writer of "requests", so it deletes the entry.
    return storage.get("requests").then(({requests}) => {
      const {[message.id]: _gone, ...rest} = requests ?? {};
      return typeof message.id === "string" ? storage.set({requests: rest}) : null;
    });
  }
  if (message?.type === "revoke_created") {
    // Popup Revoke: the worker is the single writer of "created", so it drops the document and its grants.
    return storage.get("created").then(({created}) => {
      const id = typeof message.did === "string" ? message.did.toLowerCase() : null;
      const drop = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => k.toLowerCase() !== id));
      return id && created ? storage.set({created: {...created, docs: drop(created.docs), grants: drop(created.grants)}}) : null;
    });
  }
  if (message?.type === "revoke_created_grant") {
    // Popup unticked a tab (eid) or set a preset (no eid) on a grant Claude received: drop that created grant.
    return storage.get("created").then(({created}) => {
      let updated;
      try { updated = revokeCreatedGrant(created, message.did, message.wid, message.eid ?? undefined); } catch { return null; }
      return updated !== created ? storage.set({created: updated}) : null;
    });
  }
  return null;
}
