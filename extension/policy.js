// Document scoping. Pure: the worker loads the popup-managed policy and passes it in.
// The agent may be prompt-injected by model text, so every job must name only
// documents the user authorized, and admin actions need a per-document opt-in.
const HEX = /^[0-9a-f]{24}$/i;
// Every 24-hex token in a string is a potential document id: alphanumeric-bounded
// so comma lists, hrefs and "x_<id>" match, with an optional "d" prefix for
// "d<did>::v<vid>::e<eid>::m<mid>" namespaces (the v/e/m parts are not dids).
const ID = /(?<![0-9a-z])d?([0-9a-f]{24})(?![0-9a-z])/gi;
// Keys whose value the server never resolves as a document: each id is scoped by
// a document named elsewhere in the request, and that document is checked.
const SAFE_ID_KEYS = new Set([
  "elementid", "elementids", "workspaceid", "versionid", "microversionid", "wid", "eid", "vid", "wvmid",  // ids within a document
  "elementidsource", "workspaceidsource", "anchorelementid",  // copyelement; documentIdSource is still checked
  "documentversionid", "microversion", "sourcemicroversion", "importmicroversion",  // version/microversion ids in references and feature JSON
  "nodeid", "nodeids", "featureid", "featureids", "partid", "partids", "groupid",  // feature tree, part and folder nodes
  "propertyid",  // metadata property ids (24-hex) in updateWVEMetadata
]);
// Path ids after these segments are workspace/element/version/microversion ids,
// translation ids, comment ids, tree node ids or export file ids, not documents.
const NOT_DID_AFTER = new Set(["w", "e", "v", "m", "workspace", "workspaces", "version", "versions", "microversion", "microversions",
  "translations", "comments", "featureid", "nodeid", "partid", "externaldata"]);
const ASK = "Ask the user to authorize it in the Onshape Native extension popup.";
// Requests that name no document. Everything else without a path did is refused.
const NO_DOCUMENT = [
  ["GET", /^users\/sessioninfo$/],   // signed-in user check
  ["POST", /^documents$/],           // createDocument; the new did is auto-authorized
  ["GET", /^translations\/[0-9a-f]{24}$/],  // translation status polling
  ["GET", /^translations\/translationformats$/],
  ["GET", /^thumbnails\/[0-9a-f]{32,64}(?:\/s\/\d+x\d+)?$/],  // content-hash thumbnailUri images
];
// Exact path segments, never substrings of ids or names.
const ADMIN_SEGMENTS = new Set(["share", "unshare", "sharewithsupport", "unsharefromsupport", "acl", "permission", "permissions",
  "publicaccess", "publication", "publications", "webhook", "webhooks", "application", "applications", "owner", "transfer", "movetofolder"]);
// Body fields that share, publish, email, or move a document out of the user's control.
const ADMIN_FIELD = /^(?:owner|public|email|anonymous|share)|^(?:parentid|projectid|makepublic|ispublic)$/i;
// Arrays are judged by their items, which keep the array's key.
const unset = v => v == null || v === false || v === 0 || v === "" || v === "false" || Array.isArray(v);
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function didFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://cad.onshape.com") return null;
    return parsed.pathname.match(/^\/documents\/([0-9a-f]{24})(?:\/|$)/)?.[1] ?? null;
  } catch { return null; }
}

// Document names are display-only model text (tab titles, create/copy responses):
// bounded here and rendered with textContent only. They never grant access.
export const docName = text => typeof text === "string" ? text.trim().slice(0, 120) : "";
export const docLabel = (id, entry) => entry?.name ? `${entry.name} — ${id}` : id;
const entryOk = entry => plain(entry) && (entry.name === undefined || typeof entry.name === "string");

// Decode exactly once. Anything a server or fetch() could read another way
// (double encoding, matrix parameters, stripped tabs, backslashes) is refused.
function segments(path) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { decoded = null; }
  if (decoded === null || /%25/i.test(path) || /[;\\?#\x00-\x1f]|\.\./.test(decoded))
    throw new Error(`Non-canonical API path refused: ${JSON.stringify(path.slice(0, 120))}.`);
  // Drop suffix extensions (e.g. "share.json") for exact segment matching.
  return decoded.toLowerCase().split("/").map(s => s.split(".")[0]).filter(Boolean);
}

function ids(text, found) { for (const match of text.matchAll(ID)) found.add(match[1].toLowerCase()); }

// Visits every (key, value) pair and every object key; array items keep their key.
function walk(value, visit, key = "", depth = 0) {
  if (depth > 40) throw new Error("Request nesting exceeds limit.");
  visit(key, value);
  if (value === null || typeof value !== "object") return;
  for (const [k, item] of Object.entries(value)) {
    if (Array.isArray(value)) walk(item, visit, key, depth + 1);
    else { visit("", k); walk(item, visit, k, depth + 1); }
  }
}
const collect = found => (key, value) => { if (typeof value === "string" && !SAFE_ID_KEYS.has(key.toLowerCase())) ids(value, found); };

// Text parts of a multipart body as {name: [values]}; file parts are opaque data.
// Raw bodies of any other type cannot be inspected and are refused.
function formFields(job) {
  const type = String(job.content_type ?? "");
  const boundary = type.split(";")[0].trim().toLowerCase() === "multipart/form-data" &&
    /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("Raw request bodies are accepted only as multipart/form-data uploads; send JSON as a body object.");
  const fields = {};
  // Delimiters are CRLF-prefixed (RFC 2046), exactly as the server splits them.
  for (const part of ("\r\n" + atob(job.body_base64)).split(`\r\n--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const end = part.indexOf("\r\n\r\n");
    if (end < 0) throw new Error("Malformed multipart body refused.");
    const disposition = /^content-disposition:(.*)$/im.exec(part.slice(0, end))?.[1] ?? "";
    if (/;\s*filename\*?\s*=/i.test(disposition.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) continue;
    const name = /(?:^|;)\s*name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/i.exec(disposition)?.slice(1).find(v => v !== undefined) ?? "";
    const value = part.slice(end + 4);
    (fields[name] ??= []).push(value);
    // JSON parts bind as objects; inspect their keys too.
    if (/^\s*[[{]/.test(value)) try { fields[name].push(JSON.parse(value)); } catch { /* scanned as text */ }
  }
  return fields;
}

export function classify(job) {
  if (job?.kind === "tabs") return {dids: [], admin: false};
  if (["native", "state", "schema", "open", "ui_inspect", "ui_action", "display"].includes(job?.kind)) {
    if (!HEX.test(job.target?.did ?? "")) throw new Error("Command has no valid target document id.");
    const dids = new Set([job.target.did.toLowerCase()]);
    if (job.kind === "native") walk(job.body, collect(dids));
    return {dids: [...dids], admin: false};
  }
  if (job?.kind !== "rest" || typeof job.path !== "string") throw new Error("Unclassifiable command refused.");
  const segs = segments(job.path);
  const rest = segs.slice(segs[1] && /^v\d+$/.test(segs[1]) ? 2 : 1);
  const dids = new Set();
  // translatorFormats/{did}/{wv}/{wvid}/{eid} has a bare element id.
  segs.forEach((s, i) => { if (!NOT_DID_AFTER.has(segs[i - 1]) && segs[i - 4] !== "translatorformats") ids(s, dids); });
  const pathNamesDocument = dids.size > 0;
  const write = job.method !== "GET";
  let reason;
  const visit = collect(dids);
  for (const value of write ? [job.query, job.body, job.body_base64 != null ? formFields(job) : null] : [job.query])
    walk(value, (key, v) => { visit(key, v); if (write && !reason && ADMIN_FIELD.test(key) && !unset(v)) reason = `${key} field`; });
  // The comments collection is scoped by the document id in its query or body.
  if (!pathNamesDocument && !NO_DOCUMENT.some(([method, pattern]) => method === job.method && pattern.test(rest.join("/"))) &&
      !(rest.join("/") === "comments" && dids.size))
    throw new Error(`API path names no document id and is not allowlisted: ${job.method} ${job.path.slice(0, 120)}. Use a document-scoped endpoint.`);
  const segment = rest.find(s => ADMIN_SEGMENTS.has(s));
  if (segment) reason = `${segment} endpoint`;
  else if (job.method === "DELETE" && /^documents\/(?:d\/)?[0-9a-f]{24}$/.test(rest.join("/"))) reason = "document deletion";
  return {dids: [...dids], admin: !!reason, ...(reason ? {reason} : {})};
}

// Missing policy means nothing is authorized; a malformed one refuses everything.
function checkPolicy(policy) {
  if (policy === undefined) return {docs: {}, allow_untested_native: false, allow_ui_fallback: false};
  if (!plain(policy) || !plain(policy.docs) || !Object.values(policy.docs).every(entryOk))
    throw new Error("Extension document policy is malformed; ask the user to re-authorize documents in the Onshape Native popup.");
  return policy;
}

// The popup writes "policy" and the worker writes only "created" (auto-authorized
// new documents), so neither overwrites the other's edits. Popup entries win.
export function effectivePolicy(policy, created = {}) {
  const base = checkPolicy(policy);
  if (!plain(created) || !Object.values(created).every(entryOk))
    throw new Error("Extension created-document policy is malformed; ask the user to re-authorize documents in the Onshape Native popup.");
  return {...base, docs: {...created, ...base.docs}};
}

export function authorize(job, policy) {
  const {docs, allow_ui_fallback} = checkPolicy(policy);
  // Page controls are model text the worker cannot classify; off unless the user opts in.
  if ((job?.kind === "ui_inspect" || job?.kind === "ui_action") && allow_ui_fallback !== true)
    throw new Error('UI fallback is disabled. Ask the user to enable "Advanced: allow UI fallback clicks" in the extension popup.');
  const {dids, admin, reason} = classify(job);
  for (const did of dids) if (!Object.hasOwn(docs, did)) throw new Error(`Document ${did} is not authorized. ${ASK}`);
  if (admin && !dids.length) throw new Error(`Admin action (${reason}) refused: it names no authorized document.`);
  if (admin) for (const did of dids) if (docs[did].admin !== true)
    throw new Error(`Admin action (${reason}) on document ${did} refused. Ask the user to enable "Allow admin actions" for it in the extension popup.`);
  return {dids, admin};
}

// Returns the job the extension executes: trust fields come only from policy.
export function applyPolicy(job, policy) {
  const {dids} = authorize(job, policy);
  const {docs, allow_untested_native} = checkPolicy(policy);
  return {...job, admin_allowed: dids.length > 0 && dids.every(did => docs[did].admin === true),
          allow_untested_native: allow_untested_native === true};
}

// After a successful create/copy, returns the new "created" map authorizing the
// new document (never admin), or null.
export function recordCreated(job, result, policy, created = {}, now = Date.now()) {
  if (job.kind !== "rest" || job.method === "GET" || !(result?.status >= 200 && result.status < 300)) return null;
  const segs = segments(job.path);
  const rest = segs.slice(segs[1] && /^v\d+$/.test(segs[1]) ? 2 : 1).join("/");
  const copy = rest.match(/^documents\/([0-9a-f]{24})\/workspaces\/[0-9a-f]{24}\/copy$/);
  if (!(job.method === "POST" && (rest === "documents" || copy))) return null;
  const {docs} = effectivePolicy(policy, created);
  if (copy && !Object.hasOwn(docs, copy[1])) return null;
  const id = result.body?.newDocumentId ?? result.body?.id;
  if (typeof id !== "string" || !HEX.test(id)) return null;
  const name = docName(result.body?.newDocumentName ?? result.body?.name);
  return {...created, [id.toLowerCase()]: {admin: false, source: "created", added: now, ...(name ? {name} : {})}};
}
