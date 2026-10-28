// Client-side guard for REST calls the extension sends to Onshape. Session-authenticated calls do not count against
// Onshape's annual API limit, but every endpoint is rate limited (HTTP 429 with Retry-After). The guard honours those
// signals and adds our own ceiling, so the account never hammers an endpoint. Pure: state, clock and limits are passed
// in; the caller stores the state. Editor-channel jobs (native, display, state, tabs) are not REST and pass untouched.
export const DEFAULTS = {perMinute: 60, perDay: 1500};
const MINUTE = 60000;
const LOW_REMAINING = 2;  // pause an endpoint once Onshape says this few calls are left in its window

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
  const masked = parts.map((seg, i) => /^[0-9a-f]{24}$/i.test(seg) || ID_AFTER.has((parts[i - 1] || "").toLowerCase()) ? ":id" : seg);
  return `${String(job.method || "GET").toUpperCase()} ${masked.join("/")}`;
}

function limitsOf(limits) {
  return {perMinute: positive(limits?.perMinute, DEFAULTS.perMinute), perDay: positive(limits?.perDay, DEFAULTS.perDay)};
}

// Throws RateLimitError, before anything is sent, when the call must not go out now.
export function check(state, job, now, limits) {
  if (!isRest(job)) return;
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
}

// Returns the new state after a REST call was attempted. result is null when the call failed without an answer:
// it still counts, since it may have reached Onshape.
export function record(state, job, result, now) {
  if (!isRest(job)) return state;
  const key = endpointKey(job);
  const today = dayOf(now);
  const blocked = Object.fromEntries(Object.entries(state?.blocked || {}).filter(([, b]) => b.until > now));
  const headers = result?.response_headers || {};
  if (result?.status === 429) {
    const seconds = Number(headers["retry-after"]);
    blocked[key] = {until: now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MINUTE), reason: "429"};
  } else {
    const remaining = Number(headers["x-rate-limit-remaining"] ?? headers["x-ratelimit-remaining"]);
    if (Number.isFinite(remaining) && remaining <= LOW_REMAINING) blocked[key] = {until: now + MINUTE, reason: "low"};
  }
  return {day: today, count: (state?.day === today ? state.count || 0 : 0) + 1,
          recent: [...(state?.recent || []).filter(t => now - t < MINUTE), now], blocked};
}

// For the popup: today's count, the caps in force and the endpoints still blocked.
export function summary(state, now, limits) {
  const {perMinute, perDay} = limitsOf(limits);
  return {today: state?.day === dayOf(now) ? state.count || 0 : 0, perMinute, perDay,
          blocked: Object.entries(state?.blocked || {}).filter(([, b]) => b.until > now)
            .map(([endpoint, b]) => ({endpoint, until: b.until, reason: b.reason}))};
}
