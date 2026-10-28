// Client-side guard for REST calls the extension sends to Onshape. Session-authenticated calls do not count against
// Onshape's annual API limit, but every endpoint is rate limited (HTTP 429 with Retry-After). The guard honours those
// signals and adds our own ceiling, so the account never hammers an endpoint. Pure: state, clock and limits are passed
// in; the caller stores the state. Editor-channel jobs (native, display, state, tabs) are not REST and pass untouched.
// Onshape's per-endpoint budgets are daily (Retry-After ~1 day) and small for common reads (~500/day measured on a
// free account), so the guard learns each endpoint's budget from X-Rate-Limit-Remaining and slows down well before it.
export const DEFAULTS = {perMinute: 60, perDay: 1500};
const MINUTE = 60000, DAY = 86400000;
const LOW_REMAINING = 2;  // pause an endpoint once Onshape says this few calls are left in its window
const GAP = 250;          // minimum ms between any two REST calls: no bursts
const SLOW = 0.25, SLOW_GAP = 5000;  // below 25% of an endpoint's budget, 5 s between its calls
const RESERVE = 0.10;     // below 10%, reads are refused so writes the user asked for still have room

export class RateLimitError extends Error {}

const isRest = job => job?.kind === "rest";
const pad = n => String(n).padStart(2, "0");
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// "16:30", or "2026-10-29 16:30" when the reset is not today (Onshape's Retry-After can be about a day).
const clock = (t, now) => { const d = new Date(t); return `${dayOf(t) === dayOf(now) ? "" : dayOf(t) + " "}${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const positive = (v, fallback) => Number.isInteger(v) && v > 0 ? v : fallback;

// Onshape limits per endpoint: method + path with every id segment masked (24-hex ids and the segment after
// featureid/partid/nodeid/...). The query never matters.
const ID_AFTER = new Set(["featureid", "partid", "nodeid", "occurrenceid", "fid", "sid"]);
export function endpointKey(job) {
  const parts = String(job.path || "").split("?")[0].split("/");
  const masked = parts.map((seg, i) => /^[0-9a-f]{24}$/i.test(seg) || ID_AFTER.has((parts[i - 1] || "").toLowerCase()) ? ":id"
    // Onshape's route is .../{wvm}/{wvmid}/...: workspace, version and microversion reads share one budget.
    : /^[wvm]$/.test(seg) && /^[0-9a-f]{24}$/i.test(parts[i + 1] || "") ? ":wvm" : seg);
  return `${String(job.method || "GET").toUpperCase()} ${masked.join("/")}`;
}

function limitsOf(limits) {
  return {perMinute: positive(limits?.perMinute, DEFAULTS.perMinute), perDay: positive(limits?.perDay, DEFAULTS.perDay)};
}

// Throws RateLimitError, before anything is sent, when the call must not go out now; otherwise returns how many
// ms the caller must wait before sending (0 most of the time).
export function check(state, job, now, limits) {
  if (!isRest(job)) return 0;
  const {perMinute, perDay} = limitsOf(limits);
  const key = endpointKey(job);
  const block = state?.blocked?.[key];
  if (block && block.until > now)
    throw new RateLimitError(block.reason === "low"
      ? `Onshape's allowance for ${key} is almost used up; paused until ${clock(block.until, now)}, nothing was sent.`
      : `Onshape asked to wait until ${clock(block.until, now)} for ${key} (HTTP 429); nothing was sent. Do not retry before then.`);
  const recent = (state?.recent || []).filter(t => now - t < MINUTE);
  if (recent.length >= perMinute)
    throw new RateLimitError(`Local cap of ${perMinute} calls per minute reached; nothing was sent. Wait a minute or batch the work.`);
  if (state?.day === dayOf(now) && (state.count || 0) >= perDay)
    throw new RateLimitError(`Local cap of ${perDay} calls per day reached; nothing was sent. The count resets at midnight (raise it in the popup only if needed).`);
  let wait = recent.length ? Math.max(0, GAP - (now - recent[recent.length - 1])) : 0;
  const e = state?.endpoints?.[key];
  if (e && now - e.seen < DAY && e.budget > 0) {
    if (e.remaining <= e.budget * RESERVE && String(job.method || "GET").toUpperCase() === "GET")
      throw new RateLimitError(`${key}: ${e.remaining} of about ${e.budget} Onshape calls left today; reads are paused to keep a reserve, nothing was sent. Reuse earlier results or wait for Onshape's daily reset.`);
    if (e.remaining <= e.budget * SLOW) wait = Math.max(wait, SLOW_GAP - (now - e.last));
  }
  return wait;
}

// Returns the new state after a REST call was attempted. result is null when the call failed without an answer:
// it still counts, since it may have reached Onshape.
export function record(state, job, result, now) {
  if (!isRest(job)) return state;
  const key = endpointKey(job);
  const today = dayOf(now);
  const blocked = Object.fromEntries(Object.entries(state?.blocked || {}).filter(([, b]) => b.until > now));
  const headers = result?.response_headers || {};
  const endpoints = {...(state?.endpoints || {})};
  if (result?.status === 429) {
    const seconds = Number(headers["retry-after"]);
    blocked[key] = {until: now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MINUTE), reason: "429"};
  } else {
    const remaining = Number(headers["x-rate-limit-remaining"] ?? headers["x-ratelimit-remaining"]);
    if (Number.isFinite(remaining) && remaining <= LOW_REMAINING) blocked[key] = {until: now + MINUTE, reason: "low"};
    if (Number.isFinite(remaining) && remaining >= 0) {
      // The budget is the highest remaining ever seen for this endpoint: a fresh window starts there.
      endpoints[key] = {budget: Math.max(endpoints[key]?.budget || 0, remaining), remaining, seen: now, last: now};
    }
  }
  if (endpoints[key]) endpoints[key] = {...endpoints[key], last: now};  // spacing counts every call, answered or not
  return {day: today, count: (state?.day === today ? state.count || 0 : 0) + 1,
          recent: [...(state?.recent || []).filter(t => now - t < MINUTE), now], blocked, endpoints};
}

// For the popup: today's count, the caps in force and the endpoints still blocked.
export function summary(state, now, limits) {
  const {perMinute, perDay} = limitsOf(limits);
  return {today: state?.day === dayOf(now) ? state.count || 0 : 0, perMinute, perDay,
          blocked: Object.entries(state?.blocked || {}).filter(([, b]) => b.until > now)
            .map(([endpoint, b]) => ({endpoint, until: b.until, reason: b.reason})),
          endpoints: Object.entries(state?.endpoints || {}).filter(([, e]) => now - e.seen < DAY && e.budget > 0)
            .map(([endpoint, e]) => ({endpoint, remaining: e.remaining, budget: e.budget}))
            .sort((a, b) => a.remaining / a.budget - b.remaining / b.budget)};
}
