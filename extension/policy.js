// Tab-scoped access. Pure: the worker loads the popup-managed policy and passes it in.
// The agent may be prompt-injected by model text, so every job is reduced to "needs"
// (a tab in a branch, a whole branch, a document overview, a document action) and
// each need must be granted by the user. Anything unclassified is refused.
import {checkPolicy, effectivePolicy, unionBranches, tabMode, anyBranchMode, branchMode, branchHasWrite, hasAnyGrant, actionOn} from "./grants.js";
export {checkPolicy, effectivePolicy};

const HEX = /^[0-9a-f]{24}$/i;
const H = "([0-9a-f]{24})";
// Every 24-hex token in a string is a potential document id: alphanumeric-bounded
// so comma lists, hrefs and "x_<id>" match, with an optional "d" prefix for
// "d<did>::v<vid>::e<eid>::m<mid>" namespaces (the v/e/m parts are not dids).
const ID = /(?<![0-9a-z])d?([0-9a-f]{24})(?![0-9a-z])/gi;
// "e<eid>" tokens (namespaces) are element references; "d<did>::…::e<eid>" names their document.
const ELEMENT = /(?<![0-9a-z])e([0-9a-f]{24})(?![0-9a-z])/gi;
const NAMESPACE = /(?<![0-9a-z])d([0-9a-f]{24})::(?:[^\s,:]+::)*e([0-9a-f]{24})(?![0-9a-z])/gi;
// Keys whose value the server never resolves as a document: each id is scoped by
// a document named elsewhere in the request, and that document is checked.
const SAFE_ID_KEYS = new Set([
  "elementid", "elementids", "workspaceid", "versionid", "microversionid", "wid", "eid", "vid", "wvmid",  // ids within a document
  "elementidsource", "workspaceidsource", "anchorelementid",  // copyelement; documentIdSource is still checked
  "documentversionid", "microversion", "sourcemicroversion", "importmicroversion",  // version/microversion ids in references and feature JSON
  "nodeid", "nodeids", "featureid", "featureids", "partid", "partids", "groupid",  // feature tree, part and folder nodes
  "propertyid",  // metadata property ids (24-hex) in updateWVEMetadata
]);
// Element ids in these keys are tab references (read, any branch) in the object's document:
// "eid" and every "…elementId…" key (elementIds, elementIdSource, elementIdsToDelete, insertAfterElementId, …)
// except the copyelement anchor, which only positions the copy in the destination.
const isElementKey = key => { const k = key.toLowerCase(); return k === "eid" || (k.includes("elementid") && k !== "anchorelementid"); };
const DOCUMENT_KEYS = ["documentid", "documentidsource", "did"];
// Path ids after these segments are workspace/element/version/microversion ids,
// translation ids, comment ids, tree node ids or export file ids, not documents.
const NOT_DID_AFTER = new Set(["w", "e", "v", "m", "workspace", "workspaces", "version", "versions", "microversion", "microversions",
  "translations", "comments", "featureid", "nodeid", "partid", "externaldata"]);
const ASK = "Ask the user to grant access to it in the Onshape Native extension popup.";
const FILED = "An access request was filed: ask the user to approve it in the Onshape Native popup.";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Requests that name no document. Everything else without a path did is refused.
const NO_DOCUMENT = [
  ["GET", /^users\/sessioninfo$/],   // signed-in user check
  ["POST", /^documents$/],           // createDocument; the new did is auto-authorized
  ["GET", /^translations\/[0-9a-f]{24}$/],  // translation status polling
  ["GET", /^translations\/translationformats$/],
  // No content-hash thumbnails (thumbnails/<hash>): an image of a tab's content, not scoped by any document.
];
// Exact path segments, never substrings of ids or names.
const ADMIN_SEGMENTS = new Set(["share", "unshare", "sharewithsupport", "unsharefromsupport", "acl", "permission", "permissions",
  "publicaccess", "publication", "publications", "webhook", "webhooks", "application", "applications", "owner", "transfer", "movetofolder"]);
// Body fields that share, publish, email, or move a document out of the user's control.
const ADMIN_FIELD = /^(?:owner|public|email|anonymous|share)|^(?:parentid|projectid|makepublic|ispublic)$/i;
// Arrays are judged by their items, which keep the array's key.
const unset = v => v == null || v === false || v === 0 || v === "" || v === "false" || Array.isArray(v);
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);

// Copy of READS in onshape_native/native_catalog.py (kept equal by a Python test).
export const NATIVE_READS = new Set([
  "ui.GBTUiGetFeatureSettingsCall", "ui.GBTUiMeasureCall",
  "ui.sketch.GBTUiSketchGetConstraintGraphCall", "ui.sketch.GBTUiSketchGetProjectionCall",
  "ui.GBTUiMassPropCall", "ui.GBTUiGetQueryDataCall", "ui.document.GBTUiQueryInsertables",
  "ui.assembly.GBTUiAssemblyTreeItemDefinitionRequest",
]);
// Every native command the page adapter accepts without the untested opt-in (its `allowed` set, kept equal
// by a JS test) plus the reads.
export const NATIVE_KNOWN = new Set([
  "ui.GBTUiGetFeatureSettingsCall", "ui.GBTUiUpdateEditRollbackState", "ui.GBTUiAddFeatureCall",
  "ui.GBTUiBeginEdit", "ui.GBTUiCommit", "ui.GBTUiSetFeatureSettingsCall", "ui.GBTUiMeasureCall",
  "ui.GBTUiRenameFeature", "partstudiofolders.GBTUiCreateFolder",
  "ui.sketch.GBTUiSketchGetConstraintGraphCall", "ui.sketch.GBTUiSketchStartInferencing",
  "ui.sketch.GBTUiSketchFinishInferencing", "ui.sketch.GBTUiSketchChangeInferencingMode",
  "ui.sketch.GBTUiSketchAddRectangleCall", "ui.sketch.GBTUiSketchAddCircleCall",
  "ui.sketch.GBTUiSketchGetProjectionCall", "ui.sketch.GBTUiSketchAddDimensionCall",
  "ui.sketch.GBTUiSketchModifyDimensionCall",
  "ui.assembly.GBTUiAssemblyInsertOccurrence", "ui.GBTUiBatchPartPropertyChange", "ui.assembly.GBTUiChangeOccurrenceFixedStatus",
  "ui.GBTUiSpecifyFeature", "ui.document.GBTUiEditElementGroups", "partstudiofolders.GBTUiDeleteFolder", "ui.GBTUiReorderFeatures",
  ...NATIVE_READS,
]);
// An untested command (the "allow untested native commands" opt-in) must not reach versioning, branches, release,
// sharing, permissions, locks, comments, thumbnails or document/collaboration-level commands: those are document
// actions, not tab edits. Case-insensitive, so it also refuses some harmless names (e.g. "...Block..."): fail closed.
const NATIVE_DOCUMENT_LEVEL = /Version|Workspace|Branch|Release|Revision|Merge|Restore|Publication|Share|Permission|Lock|Comment|Thumbnail/i;
// Native commands that create, delete, rename, copy or regroup tabs (mirroring creates derived tabs).
const NATIVE_TABS = new Set(["ui.document.GBTUiEditElementGroups", "ui.document.GBTUiDeleteElements", "ui.document.GBTUiCopyElements",
  "ui.document.GBTUiRenameElement", "ui.document.GBTUiInsertElement", "ui.GBTUiAssemblyMirrorCreateDerivedElements"]);
// Of those, the ones that change existing tabs: their element references are writes in the target branch.
// Copy, insert and mirror only read their sources.
const NATIVE_TAB_EDITS = new Set(["ui.document.GBTUiEditElementGroups", "ui.document.GBTUiDeleteElements", "ui.document.GBTUiRenameElement"]);
// Native commands that change the branch, create a version or rename the document: never through this extension.
const NATIVE_REFUSED = new Set(["ui.document.GBTUiUpgradeWorkspaceCall", "ui.GBTUiWorkspaceRenamed",
  "ui.assembly.GBTUiCreateExternalReferenceVersion", "ui.GBTUiDocumentRenamed"]);
const TARGETED = {state: "read", schema: "read", open: "read", display: null, ui_inspect: "read", ui_action: "write", native: null};
// Display operations (extension/display-adapter.js) by what they change:
// - inspect, capture: read the editor and viewport only.
// - camera (all actions, incl. section/section_off and isolate/make_transparent and their exits): view state of
//   this browser tab only; nothing is sent to the document (section passes the element connection to Onshape's
//   graphical-section helper, which the adapter reports as "this tab only; the model is unchanged").
// - motion start/stop/step/status/restore: renderer transforms of a prepared preview session, client-only.
// - visibility: GBTUiBatchVisibilityChange, persisted in the assembly and seen by collaborators → write.
// - motion prepare: sends GBTUiAssemblyAnimateMateRequest over the element connection; whether the server keeps
//   anything is not provable from the code, so it is a write (conservative).
// Anything else (unknown operation/action, non-object args) is a write.
const DISPLAY_READS = {inspect: null, capture: null,
  camera: new Set(["read", "save", "restore", "standard", "orientation", "fit", "zoom", "normal_to", "section", "section_off",
    "isolate", "exit_isolate", "make_transparent", "exit_make_transparent"]),
  motion: new Set(["start", "stop", "step", "status", "restore"])};
function displayMode(job) {
  const op = typeof job.operation === "string" && Object.hasOwn(DISPLAY_READS, job.operation) ? job.operation : null;
  if (!op) return "write";
  const actions = DISPLAY_READS[op];
  if (actions === null) return "read";
  const act = plain(job.args) ? job.args.action : undefined;
  return typeof act === "string" && actions.has(act) ? "read" : "write";
}

const tab = (did, wid, eid, mode) => ({did, type: "tab", wid, eid, mode});
const branch = (did, wid, mode) => ({did, type: "branch", wid, mode});
// Some write grant in the branch (whole branch or one tab): needed to create a tab there.
const branchWrite = (did, wid) => ({did, type: "branch_write", wid});
const overview = did => ({did, type: "overview"});
const action = (did, name) => ({did, type: "action", action: name});

// Non-GET element routes that only read: [tail after /e/{eid}/, read-only path without a branch segment].
const READ_POSTS = /^(?:featurescript|idtranslations|export(?:\/(?:gltf|obj|step))?|translations|content\/jsonpaths)$/;
// Document-level routes (version-stripped, lower-cased path) → needs. Anything else is refused.
const DOC_ROUTES = [
  // Overview: names, lists and history of the document; any grant on it is enough.
  ["GET", `documents/${H}`, d => [overview(d)]],
  ["GET", `documents/d/${H}/[wvm]/[0-9a-f]{24}/(?:contents|elements|unitinfo|currentmicroversion|documenthistory)`, d => [overview(d)]],
  ["GET", `documents/d/${H}/versions(?:/[0-9a-f]{24})?`, d => [overview(d)]],
  ["GET", `documents/d/${H}/workspaces`, d => [overview(d)]],
  ["GET", `documents/${H}/w/[0-9a-f]{24}/mergepreview`, d => [overview(d)]],
  ["GET", `appelements/d/${H}/[wvm]/[0-9a-f]{24}/resolvereferences`, d => [overview(d)]],
  ["GET", `documents/d/${H}/externaldata/[0-9a-f]{24}`, d => [overview(d)]],
  // Per-tab properties (descriptions, part numbers) and insertable parts/features/variables are tab content:
  // a whole-branch read on that branch; on /v/ /m/ (and insertables/d/{did}/latest) no branch grant applies, so refused.
  ["GET", `metadata/d/${H}/w/${H}/e`, (d, w) => [branch(d, w, "read")]],
  ["GET", `documents/d/${H}/w/${H}/insertables`, (d, w) => [branch(d, w, "read")]],
  // Versioning: additive operations need their toggle; merge/restore also a whole-branch write and a one-shot approval.
  ["POST", `documents/d/${H}/versions`, d => [action(d, "versions")]],
  ["POST", `documents/d/${H}/workspaces`, d => [action(d, "branches")]],
  ["POST", `documents/${H}/workspaces/${H}/merge`, (d, w) => [action(d, "merge"), branch(d, w, "write")], "merge"],
  ["POST", `documents/${H}/w/${H}/restore/[vm]/[0-9a-f]{24}`, (d, w) => [action(d, "merge"), branch(d, w, "write")], "restore"],
  // Tab creation: the tabs action and a write grant in the destination branch.
  ["POST", `(?:partstudios|assemblies|featurestudios|blobelements)/d/${H}/w/${H}`, (d, w) => [branchWrite(d, w), action(d, "tabs")]],
  ["POST", `variables/d/${H}/w/${H}/variablestudio`, (d, w) => [branchWrite(d, w), action(d, "tabs")]],
  ["POST", `drawings/d/${H}/w/${H}/create`, (d, w) => [branchWrite(d, w), action(d, "tabs")]],
  ["POST", `translations/d/${H}/w/${H}`, (d, w) => [branchWrite(d, w), action(d, "tabs")]],
  // The source tab is a body reference (documentIdSource/elementIdSource), a read need.
  ["POST", `elements/copyelement/${H}/workspace/${H}`, (d, w) => [branchWrite(d, w), action(d, "tabs")]],
  // Copying a branch to a new document reads every tab of it.
  ["POST", `documents/${H}/workspaces/${H}/copy`, (d, w) => [branch(d, w, "read")]],
  // Document attributes, notes and moving tabs to another document are admin.
  ["POST", `documents/${H}`, d => [action(d, "admin")], null, "document attributes"],
  ["POST", `documents/${H}/notes`, d => [action(d, "admin")], null, "document notes"],
  ["POST", `documents/d/${H}/w/[0-9a-f]{24}/moveelement`, d => [action(d, "admin")], null, "move tabs to another document"],
].map(([method, pattern, needs, critical, admin]) => ({method, pattern: new RegExp(`^${pattern}$`), needs, critical, admin}));

export function didFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://cad.onshape.com") return null;
    return parsed.pathname.match(/^\/documents\/([0-9a-f]{24})(?:\/|$)/)?.[1] ?? null;
  } catch { return null; }
}

// Element (or branch/version) a browser tab shows; null for other pages and hosts.
export function targetFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://cad.onshape.com") return null;
    const m = parsed.pathname.match(/^\/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})(?:\/e\/([0-9a-f]{24}))?(?:\/|$)/);
    return m ? {did: m[1], wvm: m[2], wvmid: m[3], eid: m[4] ?? null} : null;
  } catch { return null; }
}

// Document names are display-only model text (tab titles, create/copy responses):
// bounded here and rendered with textContent only. They never grant access.
export const docName = text => typeof text === "string" ? text.trim().slice(0, 120) : "";
export const docLabel = (id, entry) => entry?.name ? `${entry.name} — ${id}` : id;

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
// Element-key values are tab references (see references()), not documents.
const collect = found => (key, value) => {
  if (typeof value === "string" && !SAFE_ID_KEYS.has(key.toLowerCase()) && !isElementKey(key)) ids(value, found);
};

// Element references as tab read needs (any branch). `dids` is the enclosing document scope (the request's
// document at the top). Which document an element id belongs to depends on the endpoint (BTDrawingParams pairs
// documentId with an elementId of externalDocumentId), so an element id is checked against EVERY document key of
// its object: generic documentId/documentIdSource/did and each "<prefix>DocumentId"; the enclosing scope is only
// the fallback for an object (and its nested values) that names no document.
// Only a "<prefix>ElementId" whose own "<prefix>DocumentId" is present stays scoped to it.
// A reference with no document in scope is refused. Depth is bounded by walk() beforehand.
function references(value, dids, out) {
  const add = (did, eid) => {
    if (!did) throw new Error("Element reference names no document id; refused.");
    out.push(tab(did, null, eid.toLowerCase(), "read"));
  };
  const text = s => {
    const named = new Set();
    for (const m of s.matchAll(NAMESPACE)) { add(m[1].toLowerCase(), m[2]); named.add(m[2].toLowerCase()); }
    for (const m of s.matchAll(ELEMENT)) if (!named.has(m[1].toLowerCase())) for (const did of dids) add(did, m[1]);
  };
  if (typeof value === "string") return text(value);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) references(item, dids, out); return; }
  const entries = Object.entries(value);
  // Document keys: documentId/documentIdSource/did (generic) and any "<prefix>DocumentId" (targetDocumentId, …).
  const docs = new Set(), byPrefix = new Map();
  const tokens = (v, found) => walk(v, (_, s) => { if (typeof s === "string") ids(s, found); });
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (DOCUMENT_KEYS.includes(key)) tokens(v, docs);
    else if (key.endsWith("documentid")) { const p = key.slice(0, -"documentid".length); byPrefix.set(p, byPrefix.get(p) ?? new Set()); tokens(v, byPrefix.get(p)); }
  }
  const prefixed = [...byPrefix.values()].flatMap(s => [...s]);
  // Plain element ids, nested values and namespaces: every document key of this object; the enclosing scope
  // only as a fallback when the object names no document at all.
  const own = [...new Set([...docs, ...prefixed])].filter(Boolean);
  const scope = own.length ? own : [...new Set(dids)].filter(Boolean);
  if (!scope.length) scope.push(null);
  for (const [k, v] of entries) {
    text(k);
    if (isElementKey(k)) {
      // "<prefix>ElementId(s)" belongs to its own "<prefix>DocumentId" when present, else to every document in scope.
      const mine = byPrefix.get(k.toLowerCase().split("elementid")[0]);
      const where = mine?.size ? [...mine] : scope;
      // Strings, comma lists and arrays of them; nested objects get their own scope below.
      const eids = new Set();
      for (const s of [v].flat(Infinity)) if (typeof s === "string") ids(s, eids);
      for (const eid of eids) for (const did of where) add(did, eid);
    }
    references(v, scope, out);
  }
}

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

// An export/translation stored in the document creates a tab. A storeInDocument key at any depth
// stores unless every value it holds (arrays included) is explicitly false.
function storesInDocument(values) {
  let stores = false;
  for (const value of values) walk(value, (key, v) => {
    if (key.toLowerCase() === "storeindocument" && !Array.isArray(v) && ![undefined, null, false, "false"].includes(v)) stores = true;
  });
  return stores;
}

const refused = (job, why) => new Error(`${why}: ${job.method} ${job.path.slice(0, 120)}.`);

// A truthy withThumbnails / thumbnail* query flag at any depth (array items and objects count as on).
const THUMBNAIL_FLAG = /^(?:withthumbnails|thumbnail)/i;
const off = v => v == null || v === false || v === 0 || (typeof v === "string" && ["", "false", "0"].includes(v.trim().toLowerCase()));
function thumbnailFlag(query) {
  let on = false;
  walk(query, (key, v) => { if (THUMBNAIL_FLAG.test(key) && !Array.isArray(v) && !off(v)) on = true; });
  return on;
}

// Needs of an element path …/d/{did}/[{w|v|m}/{id}/]e/{eid}/{tail}.
function elementNeeds(job, rest, values) {
  const m = rest.match(new RegExp(`^(?:[^/]+/)*?d/${H}/(?:([wvm])/${H}/)?e/${H}(?:/(.*))?$`));
  if (!m) return null;
  const [, did, wvm, id, eid, tail = ""] = m;
  const wid = wvm === "w" ? id : null;
  const post = job.method === "POST";
  if (job.method === "GET") return [tab(did, wid, eid, "read")];
  // Without a branch segment only configuration encoding is a read-only POST.
  // Exports and translations stored in the document create a tab: not reads.
  const readPost = wvm ? READ_POSTS.test(tail) : rest === `elements/d/${did}/e/${eid}/configurationencodings`;
  const stored = readPost && storesInDocument(values);
  if (post && readPost && !stored) return [tab(did, wid, eid, "read")];
  if (!wid) throw refused(job, "Writes are only allowed in a workspace (/w/) branch; versions and microversions are read-only");
  if (job.method === "DELETE" && rest === `elements/d/${did}/w/${wid}/e/${eid}`) return [tab(did, wid, eid, "write"), action(did, "tabs")];
  if (post && rest === `assemblies/d/${did}/w/${wid}/e/${eid}/bomelement`)
    return [tab(did, wid, eid, "read"), branchWrite(did, wid), action(did, "tabs")];
  // Element metadata holds the tab name (renaming a tab); a stored export/translation, or a blob update
  // stored in the document (it may translate into a new tab), creates a tab.
  if (post && (rest === `metadata/d/${did}/w/${wid}/e/${eid}` || stored ||
      (rest === `blobelements/d/${did}/w/${wid}/e/${eid}` && storesInDocument(values)))) return [tab(did, wid, eid, "write"), action(did, "tabs")];
  return [tab(did, wid, eid, "write")];
}

function classifyTargeted(job) {
  const {did, wid, eid} = job.target ?? {};
  if (![did, wid, eid].every(id => typeof id === "string" && HEX.test(id))) throw new Error("Command has no valid target document, branch and tab id.");
  const [d, w, e] = [did, wid, eid].map(id => id.toLowerCase());
  const command = job.command;
  if (job.kind === "native" && NATIVE_REFUSED.has(command)) throw new Error(`Native command ${String(command).slice(0, 80)} is refused: it changes the branch, versions or the document itself.`);
  if (job.kind === "native" && typeof command === "string" && !NATIVE_KNOWN.has(command) && !NATIVE_TABS.has(command) &&
      (NATIVE_DOCUMENT_LEVEL.test(command) || /^ui\.(?:document|collaboration)\./i.test(command)))
    throw new Error(`Untested native command ${command.slice(0, 80)} is refused: it may act on versions, branches, sharing or the document itself.`);
  const mode = job.kind === "display" ? displayMode(job) : TARGETED[job.kind] ?? (NATIVE_READS.has(command) ? "read" : "write");
  const needs = [tab(d, w, e, mode)];
  if (job.kind === "native" && NATIVE_TABS.has(command)) needs.push(action(d, "tabs"));
  // Insertables list parts/features/variables of other tabs: whole-branch read, like the REST insertables route.
  if (job.kind === "native" && command === "ui.document.GBTUiQueryInsertables") needs.push(branch(d, w, "read"));
  if (job.kind === "native") {
    const docs = new Set();
    walk(job.body, collect(docs));
    const refs = [];
    references(job.body, [d], refs);
    // Deleting, renaming or regrouping tabs changes the referenced tabs in the target branch.
    const edits = NATIVE_TAB_EDITS.has(command);
    for (const r of refs) needs.push(edits ? tab(r.did, w, r.eid, "write") : r);
    for (const id of docs) needs.push(overview(id));
  }
  return {needs: finish(needs), admin: false};
}

// Dedupe; an overview is implied by any tab or branch need on the same document.
// Order: tab/branch needs first (they file access requests), then overviews, then actions.
function finish(needs) {
  const covered = new Set(needs.filter(n => ["tab", "branch", "branch_write"].includes(n.type)).map(n => n.did));
  const seen = new Map();
  // A tab read is implied by a write on the same tab in the same branch, or in any branch when the read is branch-free.
  const implied = n => n.type === "tab" && n.mode === "read" && needs.some(m =>
    m.type === "tab" && m.mode === "write" && m.did === n.did && m.eid === n.eid && (n.wid === null || m.wid === n.wid));
  for (const n of needs) if (!(n.type === "overview" && covered.has(n.did)) && !implied(n)) seen.set(JSON.stringify(n), n);
  const rank = {tab: 0, branch: 0, branch_write: 0, overview: 1, action: 2};
  return [...seen.values()].sort((a, b) => rank[a.type] - rank[b.type]);
}

// Merge body {id, type, defaultMergeStrategy, mergeStrategyElementOverrides}, restore body
// {defaultRestoreStrategy, elementIdToStrategyOverride}. The merge source is a branch (read need) or a version
// (overview only); override keys are element ids (tab reads). Returns the needs and the body left to scan.
const OVERRIDES = {merge: "mergestrategyelementoverrides", restore: "elementidtostrategyoverride"};
function criticalBody(job, did, critical) {
  const body = job.body ?? {};
  if (!plain(body)) throw refused(job, "Merge/restore body must be a JSON object");
  const needs = [], rest = {};
  for (const [k, v] of Object.entries(body)) {
    const key = k.toLowerCase();
    if (critical === "merge" && (key === "id" || key === "type")) continue;
    if (key !== OVERRIDES[critical]) { rest[k] = v; continue; }
    if (!plain(v)) throw refused(job, "Strategy overrides must be an object keyed by element id");
    for (const eid of Object.keys(v)) {
      if (!HEX.test(eid)) throw refused(job, "Strategy override key is not an element id");
      needs.push(tab(did, null, eid.toLowerCase(), "read"));
    }
    rest[k] = Object.values(v);
  }
  if (critical === "merge") {
    const type = typeof body.type === "string" ? body.type.toLowerCase() : null;
    if (type === "workspace" && typeof body.id === "string" && HEX.test(body.id)) needs.push(branch(did, body.id.toLowerCase(), "read"));
    else if (!(type === "version" && typeof body.id === "string" && HEX.test(body.id))) throw refused(job, "Merge source must be a workspace or version id");
  }
  return {needs, body: rest};
}

export function classify(job) {
  if (job?.kind === "tabs") return {needs: [], admin: false};
  if (Object.hasOwn(TARGETED, job?.kind ?? "")) return classifyTargeted(job);
  if (job?.kind !== "rest" || typeof job.path !== "string") throw new Error("Unclassifiable command refused.");
  if (!METHODS.has(job.method)) throw new Error("Unsupported HTTP method refused.");
  const segs = segments(job.path);
  if (segs[0] !== "api") throw new Error("API paths start with /api/.");
  const rest = segs.slice(segs[1] && /^v\d+$/.test(segs[1]) ? 2 : 1).join("/");
  const pathDids = new Set();
  // translatorFormats/{did}/{wv}/{wvid}/{eid} has a bare element id.
  segs.forEach((s, i) => { if (!NOT_DID_AFTER.has(segs[i - 1]) && segs[i - 4] !== "translatorformats") ids(s, pathDids); });
  const write = job.method !== "GET";
  const values = write ? [job.query, job.body, job.body_base64 != null ? formFields(job) : null] : [job.query];
  const docs = new Set();
  let reason;
  const visit = collect(docs);
  for (const value of values)
    walk(value, (key, v) => { visit(key, v); if (write && !reason && ADMIN_FIELD.test(key) && !unset(v)) reason = `${key} field`; });

  let needs, critical, requestDid = null;
  if (!pathDids.size) {
    // The comments collection is scoped by the document id in its query or body.
    if (!NO_DOCUMENT.some(([method, pattern]) => method === job.method && pattern.test(rest)) && !(rest === "comments" && docs.size))
      throw new Error(`API path names no document id and is not allowlisted: ${job.method} ${job.path.slice(0, 120)}. Use a document-scoped endpoint.`);
    needs = [];
  } else {
    // A second element in the path would be ignored by the rules below.
    const elements = segs.filter((s, i) => s === "e" && HEX.test(segs[i + 1] ?? "")).length;
    if (elements > 1) throw refused(job, "API route not classified (several elements)");
    const formats = rest.match(new RegExp(`^elements/translatorformats/${H}/([wv])/${H}/${H}$`));
    if (formats && job.method === "GET") needs = [tab(formats[1], formats[2] === "w" ? formats[3] : null, formats[4], "read")];
    else needs = elementNeeds(job, rest, values);
    requestDid = needs?.[0]?.did ?? null;
    if (!needs) {
      const route = DOC_ROUTES.map(r => r.method === job.method && [r, rest.match(r.pattern)]).find(x => x && x[1]);
      if (route) {
        const [r, match] = route;
        needs = r.needs(...match.slice(1));
        // An overview shows names, never content: thumbnails would render other tabs.
        if (needs.every(n => n.type === "overview") && thumbnailFlag(job.query)) throw refused(job, "Thumbnails are tab content, refused on overview routes");
        critical = r.critical ?? undefined;
        requestDid = match[1];
        if (r.admin && !reason) reason = r.admin;
        if (critical && job.body_base64 == null) {
          // Source branch and override element ids are references, not documents: rescan the rest of the body.
          const c = criticalBody(job, requestDid, critical);
          needs.push(...c.needs);
          values[1] = c.body;
          docs.clear();
          for (const value of values) walk(value, visit);
        }
      } else if (!elements && (rest.split("/").some(s => ADMIN_SEGMENTS.has(s)) || (job.method === "DELETE" && /^documents\/(?:d\/)?[0-9a-f]{24}$/.test(rest)))) {
        needs = [];  // admin-only routes: the admin action on every named document, below
      } else throw refused(job, "API route not classified, refused by default");
    }
  }
  const segment = rest.split("/").find(s => ADMIN_SEGMENTS.has(s));
  if (segment) reason = `${segment} endpoint`;
  else if (job.method === "DELETE" && /^documents\/(?:d\/)?[0-9a-f]{24}$/.test(rest)) reason = "document deletion";
  // An approval is bound to the exact JSON request; raw bodies cannot be compared.
  if (critical && job.body_base64 != null) throw refused(job, "Raw bodies are refused for merge/restore");

  // Element references default to the request's document; without one, to every document the request names.
  const scope = requestDid ? [requestDid] : pathDids.size ? [...pathDids] : [...docs];
  const refs = [];
  for (const value of values) references(value, scope, refs);
  needs.push(...refs);
  if (rest === "comments") {
    // Comments belong to a tab, not a branch: the comment's own top-level documentId/did and elementId
    // (body for writes, query for reads) need write (any branch) to post and read to list.
    const top = write ? job.body : job.query;
    const field = names => (plain(top) ? Object.entries(top) : []).filter(([k]) => names.includes(k.toLowerCase()))
      .flatMap(([, v]) => [v].flat()).filter(s => typeof s === "string");
    const dids = new Set(), eids = new Set();
    for (const s of field(["documentid", "did"])) ids(s, dids);
    for (const s of field(write ? ["elementid"] : ["elementid", "eid"])) ids(s, eids);
    if (!dids.size || !eids.size) throw refused(job, "Comments need the top-level document and element id of a granted tab");
    for (const did of dids) for (const eid of eids) needs.push(tab(did, null, eid, write ? "write" : "read"));
  }
  for (const did of [...pathDids, ...docs]) needs.push(overview(did));
  if (reason) for (const did of new Set(needs.map(n => n.did))) needs.push(action(did, "admin"));
  return {needs: finish(needs), admin: !!reason, ...(reason ? {reason} : {}), ...(critical ? {critical} : {})};
}

// Thrown for an unmet tab/branch/action/approval need; the worker files a request from `need`.
export class AccessError extends Error {
  constructor(message, need) { super(message); this.name = "AccessError"; this.need = need; }
}

// Stable JSON (sorted keys) of what the server receives: an approval binds this exact request.
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : plain(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
export const jobKey = job => stable({method: job.method ?? null, path: job.path ?? null, query: job.query ?? null, body: job.body ?? null});

// authorize() takes the effective policy (effectivePolicy output). Anything else fails closed.
function effective(policy) {
  if (policy === undefined) return checkPolicy(undefined);
  if (!plain(policy) || policy.version !== 2 || !plain(policy.docs) ||
      !Object.values(policy.docs).every(d => plain(d) && plain(d.branches ?? {}) && plain(d.actions ?? {})))
    throw new Error("Extension document policy is malformed; ask the user to re-authorize in the Onshape Native popup.");
  return policy;
}

const atLeast = (mode, need) => mode === "write" || (mode === "read" && need === "read");

export function authorize(job, policy, approvals = {}, consumed = {}, now = Date.now()) {
  const p = effective(policy);
  // Page controls are model text the worker cannot classify; off unless the user opts in.
  if ((job?.kind === "ui_inspect" || job?.kind === "ui_action") && p.allow_ui_fallback !== true)
    throw new Error('UI fallback is disabled. Ask the user to enable "Advanced: allow UI fallback clicks" in the extension popup.');
  const {needs, admin, reason, critical} = classify(job);
  if (admin && !needs.length) throw new Error(`Admin action (${reason}) refused: it names no authorized document.`);
  for (const need of needs) {
    const {did, type, wid, eid, mode} = need;
    if (type === "tab" && !atLeast(wid ? tabMode(p, did, wid, eid) : anyBranchMode(p, did, eid), mode))
      throw new AccessError(`No ${mode} access to tab ${eid} in ${wid ? `branch ${wid}` : "any branch"} of document ${did}. ${FILED}`, need);
    // The worker files a request for every AccessError need except admin/merge actions (requests.js fileRequest);
    // branch_write and overview cannot be approved from a banner, so those messages say what to grant instead.
    if (type === "branch" && !atLeast(branchMode(p, did, wid), mode))
      throw new AccessError(`No ${mode} access to the whole branch ${wid} of document ${did}. ${FILED}`, need);
    if (type === "branch_write" && !branchHasWrite(p, did, wid))
      throw new AccessError(`No write access in branch ${wid} of document ${did}: creating a tab needs a write grant on a tab or the whole branch. Ask the user to grant write on a tab of that branch, or the whole branch, in the Onshape Native popup.`, need);
    if (type === "overview" && !hasAnyGrant(p, did)) throw new Error(`Document ${did} is not authorized. ${ASK}`);
    if (type === "action" && !actionOn(p, did, need.action)) {
      if (need.action === "admin") throw new AccessError(`Admin action (${reason}) on document ${did} refused. Ask the user to enable the "admin" document action for it in the Onshape Native popup.`, need);
      if (need.action === "merge") throw new AccessError(`Document action "merge" is off for ${did}. Ask the user to enable "Merge / restore" in the Onshape Native popup (Document actions).`, need);
      throw new AccessError(`Document action "${need.action}" is off for ${did}. ${FILED}`, need);
    }
  }
  if (!critical) return {needs};
  // Merge/restore overwrite work: one popup approval per exact request, used once (consumed[key] === the approval it used), before it expires.
  const key = jobKey(job);
  const expires = plain(approvals) && Object.hasOwn(approvals, key) ? approvals[key] : undefined;
  if (!(typeof expires === "number" && expires > now) || !plain(consumed) || consumed[key] === expires) {
    const did = needs.find(n => n.type === "branch").did;
    throw new AccessError(`The ${critical} needs a one-time approval: ask the user to approve this exact ${critical} in the Onshape Native popup, then retry the same request.`,
      {did, type: "approval", critical, key});
  }
  return {needs, approvalKey: key};
}

// Returns the job the extension executes: trust fields come only from policy.
export function applyPolicy(job, policy, approvals = {}, consumed = {}, now = Date.now()) {
  const {needs} = authorize(job, policy, approvals, consumed, now);
  const p = effective(policy);
  const dids = [...new Set(needs.map(n => n.did))];
  return {...job, admin_allowed: dids.length > 0 && dids.every(did => actionOn(p, did, "admin")),
          allow_untested_native: p.allow_untested_native === true};
}

// After a successful create/copy/branch/tab creation, returns the new "created" object
// ({docs, grants}, inputs untouched) with the grants the new object inherits, or null.
// Never grants more than the policy already allowed: a created document is never admin,
// a new branch gets only the union of the document's granted tabs/`all`, a new tab gets write.
export function recordCreated(job, result, policy, created = {}, now = Date.now()) {
  if (job.kind !== "rest" || job.method !== "POST" || !(result?.status >= 200 && result.status < 300)) return null;
  const body = plain(result.body) ? result.body : {};
  // First of the given response fields that is a 24-hex id.
  const newId = (...keys) => { const id = keys.map(k => body[k]).find(v => typeof v === "string" && HEX.test(v)); return id?.toLowerCase(); };
  try {
    const segs = segments(job.path);
    const rest = segs.slice(segs[1] && /^v\d+$/.test(segs[1]) ? 2 : 1).join("/");
    const eff = effectivePolicy(policy, created);
    const copy = rest.match(new RegExp(`^documents/${H}/workspaces/${H}/copy$`));
    if (rest === "documents" || copy) {
      // A copy reads every tab of the source branch: whole-branch read is required (also checked by authorize).
      if (copy && !branchMode(eff, copy[1], copy[2])) return null;
      const id = newId("newDocumentId", "id");
      if (!id) return null;
      const name = docName(body.newDocumentName ?? body.name);
      const entry = {source: "created", added: now, ...(name ? {name} : {}), branches: {"*": {all: "write", tabs: {}}},
        actions: {versions: true, branches: true, tabs: true, merge: true, admin: false}};
      return {...created, docs: {...created.docs, [id]: entry}};
    }
    // Where the new id lands: [did, wid, new tab id] for tab creation, [did, new wid] for a branch.
    const branches = rest.match(new RegExp(`^documents/d/${H}/workspaces$`));
    const tabRoute = DOC_ROUTES.find(r => r.method === "POST" && r.pattern.test(rest) && r.needs(...rest.match(r.pattern).slice(1)).some(n => n.type === "branch_write"));
    if (!branches && !tabRoute) return null;
    const [did, wid] = branches ? [branches[1]] : rest.match(tabRoute.pattern).slice(1);
    const docBranches = eff.docs[did]?.branches;
    const id = newId("id", "newElementId", "elementId");
    if (!docBranches || !id) return null;
    let grant;
    if (branches) {
      // Onshape branches from a version, so the source branch is unknown: inherit the union over the document's
      // concrete branches. "*" is skipped (a created document already covers new branches).
      const acc = {[id]: {tabs: {}}};
      for (const [w, b] of Object.entries(docBranches)) if (w !== "*") unionBranches(acc, {[id]: b});
      grant = acc[id];
      delete grant.name;  // the source branch's display name is not the new branch's
      if (!grant.all && !Object.keys(grant.tabs).length) return null;
    } else {
      if (!branchHasWrite(eff, did, wid)) return null;
      grant = {tabs: {[id]: {mode: "write"}}};
    }
    const target = branches ? id : wid;
    const prior = created.grants?.[did]?.branches ?? {};
    const merged = structuredClone(prior);
    unionBranches(merged, {[target]: grant});
    return {...created, grants: {...created.grants, [did]: {...created.grants?.[did], branches: merged}}};
  } catch { return null; }
}
