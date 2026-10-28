import test from "node:test";
import assert from "node:assert/strict";
import {DEFAULTS, RateLimitError, check, endpointKey, record, summary} from "../extension/rate-guard.js";

const D = "0123456789abcdef01234567", W = "89abcdef0123456789abcdef", E = "fedcba9876543210fedcba98";
const get = (path = `/api/v10/partstudios/d/${D}/w/${W}/e/${E}/features`) => ({kind: "rest", method: "GET", path});
const at = (h, m = 0, s = 0) => new Date(2026, 9, 28, h, m, s).getTime();
const ok = {status: 200, body: {}, response_headers: {}};

test("endpoint keys mask document, element and feature ids, never the query", () => {
  assert.equal(endpointKey(get()), "GET /api/v10/partstudios/d/:id/w/:id/e/:id/features");
  assert.equal(endpointKey({kind: "rest", method: "POST", path: `/api/v10/partstudios/d/${D}/w/${W}/e/${E}/features/featureid/F9Iro1KS9fdAjsA_73`}),
    "POST /api/v10/partstudios/d/:id/w/:id/e/:id/features/featureid/:id");
  assert.equal(endpointKey(get(`/api/v10/parts/d/${D}/w/${W}/e/${E}/partid/JFD/massproperties`)), "GET /api/v10/parts/d/:id/w/:id/e/:id/partid/:id/massproperties");
});

test("editor jobs are neither checked nor counted", () => {
  const state = record({}, {kind: "native", command: "ui.GBTUiInterferenceCall"}, ok, at(10));
  assert.deepEqual(state, {});
  assert.doesNotThrow(() => check({blocked: {}}, {kind: "display"}, at(10), DEFAULTS));
});

test("a 429 blocks that endpoint until Retry-After, without blocking others", () => {
  const state = record({}, get(), {status: 429, body: {}, response_headers: {"retry-after": "120"}}, at(10));
  assert.throws(() => check(state, get(), at(10, 1, 59), DEFAULTS), error =>
    error instanceof RateLimitError && /Onshape asked to wait until 10:02/.test(error.message) && /nothing was sent/.test(error.message));
  assert.doesNotThrow(() => check(state, get(`/api/v10/parts/d/${D}/w/${W}/e/${E}`), at(10, 1), DEFAULTS));
  assert.doesNotThrow(() => check(state, get(), at(10, 2, 0), DEFAULTS));
});

test("a 429 without Retry-After blocks for 60 s", () => {
  const state = record({}, get(), {status: 429, body: {}, response_headers: {}}, at(10));
  assert.throws(() => check(state, get(), at(10, 0, 59), DEFAULTS), RateLimitError);
  assert.doesNotThrow(() => check(state, get(), at(10, 1, 0), DEFAULTS));
});

test("a nearly exhausted endpoint pauses for 60 s before Onshape has to refuse", () => {
  const low = record({}, get(), {...ok, response_headers: {"x-rate-limit-remaining": "2"}}, at(10));
  assert.throws(() => check(low, get(), at(10, 0, 30), DEFAULTS), /almost used up/);
  const fine = record({}, get(), {...ok, response_headers: {"x-rate-limit-remaining": "40"}}, at(10));
  assert.doesNotThrow(() => check(fine, get(), at(10, 0, 1), DEFAULTS));
});

test("per-minute cap counts every endpoint over a sliding minute", () => {
  let state = {};
  for (let i = 0; i < 3; i++) state = record(state, get(), ok, at(10, 0, i));
  const limits = {perMinute: 3, perDay: 100};
  assert.throws(() => check(state, get(), at(10, 0, 30), limits), /3 calls per minute/);
  assert.doesNotThrow(() => check(state, get(), at(10, 1, 1), limits));
});

test("daily cap resets at local midnight", () => {
  let state = {};
  for (let i = 0; i < 2; i++) state = record(state, get(), ok, at(23, 50, i));
  const limits = {perMinute: 60, perDay: 2};
  assert.throws(() => check(state, get(), at(23, 59), limits), /2 calls per day/);
  assert.doesNotThrow(() => check(state, get(), new Date(2026, 9, 29, 0, 0, 1).getTime(), limits));
  assert.equal(record(state, get(), ok, new Date(2026, 9, 29, 0, 0, 1).getTime()).count, 1);
});

test("a call that failed before an answer still counts, since it may have reached Onshape", () => {
  assert.equal(record({}, get(), null, at(10)).count, 1);
});

test("summary reports today's use and live blocks only", () => {
  let state = record({}, get(), {status: 429, body: {}, response_headers: {"retry-after": "60"}}, at(10));
  state = record(state, get(`/api/v10/parts/d/${D}/w/${W}/e/${E}`), {status: 429, body: {}, response_headers: {"retry-after": "1"}}, at(10));
  const s = summary(state, at(10, 0, 30), {perMinute: 60, perDay: 1500});
  assert.equal(s.today, 2);
  assert.deepEqual(s.blocked.map(b => b.endpoint), ["GET /api/v10/partstudios/d/:id/w/:id/e/:id/features"]);
  assert.equal(s.perDay, 1500);
});

test("malformed stored limits fall back to the defaults", () => {
  let state = {};
  for (let i = 0; i < 5; i++) state = record(state, get(), ok, at(10, 0, i));
  assert.doesNotThrow(() => check(state, get(), at(10, 0, 10), {perMinute: "lots", perDay: -1}));
});

test("a reset on another day names the date, as Onshape's Retry-After can be about a day", () => {
  const state = record({}, get(), {status: 429, body: {}, response_headers: {"retry-after": "83040"}}, at(17, 26));
  assert.throws(() => check(state, get(), at(17, 27), DEFAULTS), /wait until 2026-10-29 16:30/);
});
