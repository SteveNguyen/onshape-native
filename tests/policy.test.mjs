import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classify, authorize, applyPolicy, recordCreated, effectivePolicy, didFromUrl, targetFromUrl, docName, docLabel,
  jobKey, AccessError, NATIVE_READS} from '../extension/policy.js';

const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24), W = 'e'.repeat(24), E = 'f'.repeat(24);
const W2 = '1'.repeat(24), E2 = '2'.repeat(24), V = '3'.repeat(24);
// "Whole document A, read+write, tab actions on": what the v1 tests meant by an authorized document.
// The popup cannot grant "*" (all branches), so it comes from a worker-created entry.
const createdDoc = {source: 'created', added: 1, branches: {'*': {all: 'write', tabs: {}}}, actions: {tabs: true}};
const policy = (admin = false, extra = {}) => admin
  ? effectivePolicy({version: 2, docs: {[A]: {branches: {[W]: {all: 'write', tabs: {}}}, actions: {admin: true, tabs: true}}}, ...extra})
  : effectivePolicy({version: 2, docs: {}, ...extra}, {docs: {[A]: createdDoc}});
// Popup-only v2 policy (effective form).
const v2 = (docs, extra = {}) => effectivePolicy({version: 2, docs, ...extra});
const rest = (path, method = 'GET', more = {}) => ({kind: 'rest', method, path, query: {}, body: null, ...more});
const allowed = (job, p = policy(), ...more) => assert.doesNotThrow(() => authorize(job, p, ...more));
const refused = (job, pattern, p = policy(), ...more) => assert.throws(() => authorize(job, p, ...more), pattern);
const b64 = text => Buffer.from(text, 'latin1').toString('base64');
// Multipart body as httpx/browsers encode it: CRLF before every delimiter.
const form = (fields = [], files = [], boundary = 'XyZ') => {
  let text = '';
  for (const [name, value] of fields) text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  for (const [name, value] of files) text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="a.step"\r\nContent-Type: application/octet-stream\r\n\r\n${value}\r\n`;
  return {content_type: `multipart/form-data; boundary=${boundary}`, body_base64: b64(text + `--${boundary}--\r\n`)};
};
// Needs compared as a set, independent of order and key order.
const stable = v => JSON.stringify(v, Object.keys(v).sort());
const tab = (did, wid, eid, mode) => ({did, type: 'tab', wid, eid, mode});
const overview = did => ({did, type: 'overview'});
const action = (did, name) => ({did, type: 'action', action: name});
const branch = (did, wid, mode) => ({did, type: 'branch', wid, mode});
const needs = (job, expected, msg) => assert.deepEqual(classify(job).needs.map(stable).sort(), expected.map(stable).sort(), msg ?? job.path ?? job.kind);
const hasNeed = (job, need) => assert.ok(classify(job).needs.map(stable).includes(stable(need)), `${job.path ?? job.kind} needs ${stable(need)}`);

test('targeted kinds use target.did', () => {
  const ui = policy(false, {allow_ui_fallback: true});
  for (const kind of ['native', 'state', 'schema', 'open', 'ui_inspect', 'ui_action', 'display']) {
    assert.deepEqual([...new Set(classify({kind, target: {did: A, wid: W, eid: E}}).needs.map(n => n.did))], [A]);
    allowed({kind, target: {did: A, wid: W, eid: E}}, ui);
    refused({kind, target: {did: B, wid: W, eid: E}}, new RegExp(`document ${B}.*popup`), ui);
  }
  assert.throws(() => classify({kind: 'state'}));
  assert.throws(() => classify({kind: 'state', target: {did: A, wid: 'x', eid: E}}));
  assert.throws(() => classify({kind: 'unknown'}));
});

test('externaldata file ids are not documents (live STEP export download)', () => {
  allowed(rest(`/api/v10/documents/d/${A}/externaldata/${C}`));
  refused(rest(`/api/v10/documents/d/${B}/externaldata/${C}`), new RegExp(`Document ${B} is not authorized`));
});

test('UI fallback needs its own popup opt-in, even with admin', () => {
  for (const kind of ['ui_inspect', 'ui_action']) {
    refused({kind, target: {did: A, wid: W, eid: E}}, /UI fallback.*popup/, policy(true));
    // A non-boolean flag is malformed, never an opt-in.
    assert.throws(() => policy(true, {allow_ui_fallback: 'true'}), /malformed/);
  }
  allowed({kind: 'state', target: {did: A, wid: W, eid: E}});
});

test('native bodies are scanned for other documents', () => {
  const insert = body => ({kind: 'native', target: {did: A, wid: W, eid: E}, command: 'ui.assembly.GBTUiAssemblyInsertOccurrence', body});
  refused(insert({insertables: [{documentId: B, versionId: W, elementId: E}]}), new RegExp(B));
  refused(insert({insertables: [{namespace: `d${B}::v${W}::e${E}::m${W}`}]}), new RegExp(B));
  allowed(insert({insertables: [{documentId: A, versionId: W, elementId: E, microversionId: C}]}));
});

test('rest path document ids are extracted in every encoding and casing', () => {
  for (const path of [`/api/v10/documents/${A}`, `/api/partstudios/d/${A}/w/${W}/e/${E}/features`,
    `/api/v6/documents/d/${A}/w/${W}/contents`, `/api/v6/documents/D/${A.toUpperCase()}/w/${W}/elements`,
    `/api/v6/documents/d%2F${A}%2Fw%2F${W}%2Fcontents`, `/api/documents//${A}`]) {
    assert.deepEqual([...new Set(classify(rest(path)).needs.map(n => n.did))], [A], path);
    allowed(rest(path));
  }
  for (const path of [`/api/v6/documents/d%2F${B}%2Fw%2F${W}%2Fcontents`, `/api/v6/documents/D/${B.toUpperCase()}/w/${W}/contents`,
    `/api/v6/documents/${B}`, `/api/v6/partstudios/D/${B.toUpperCase()}/w/${W}/e/${E}`]) refused(rest(path), new RegExp(B));
  // Unclassified routes are refused whatever document they name.
  for (const path of [`/api/v6/partstudios/d%2F${B}%2Fw`, `/api/v6/documents/${A}/d/${B}`, `/api/v6/documents/${A}/x/${B}`,
    `/api/v6/thumbnails/document/${B}`]) refused(rest(path), /not classified/);
  refused(rest(`/api/v6/elements/copyelement/${B}/workspace/${W}`, 'POST'), new RegExp(B));
  refused(rest(`/api/v6/elements/translatorFormats/${B}/w/${W}/${E}`), new RegExp(B));
});

test('non-canonical paths are refused before parsing', () => {
  for (const path of [`/api/v6/documents/${A};x=1`, `/api/v6/documents/${A}%3Bx`, `/api/v6/partstudios/d%252F${A}%252Fw`,
    `/api/v6/documents/${A.slice(0, 5)}\t${A.slice(5)}`, `/api/v6/documents/${A}%09`, `/api/v6/documents/${A}\n`, `/api/v6/documents/${A}\x00`,
    `/api/v6/documents\\${A}`, `/api/v6/documents%5C${A}`, `/api/v6/documents/${A}?x=1`, `/api/v6/documents/${A}%23x`, '/api/v6/%E0%A4%A']) {
    refused(rest(path), /canonical/i);
  }
});

test('reviewer bypasses are refused', () => {
  const ps = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}`;
  const json = body => ({content_type: 'application/JSON', body_base64: b64(JSON.stringify(body))});
  for (const [job, pattern] of [
    [rest(`/api/v6/documents/${A}`, 'POST', {body: {isPublic: true}}), /admin/i],
    [rest(`/api/v6/assemblies/d/${A}/w/${W}/e/${E}/instances`, 'POST', {body: {documentId: B}}), new RegExp(B)],
    // Raw bodies are opaque unless multipart.
    [rest(`/api/v6/documents/${A}`, 'POST', json({isPublic: true})), /multipart/],
    [rest(`/api/v6/assemblies/d/${A}/w/${W}/e/${E}/instances`, 'POST', json({documentId: B, versionId: W, elementId: E})), /multipart/],
    [rest('/api/v6/documents', 'POST', json({name: 'x', isPublic: true})), /multipart/],
    // Admin-equivalent fields.
    [rest(`/api/v6/documents/${A}`, 'POST', {body: {ownerId: 'team', ownerType: 1}}), /admin.*ownerId/i],
    [rest(`/api/v6/documents/${A}`, 'POST', {body: {parentId: 'folder', projectId: 'project'}}), /admin/i],
    [rest(`/api/v6/documents/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'x', parentId: 'folder'}}), /admin/i],
    [rest(`${ps}/translations`, 'POST', {body: {formatName: 'STEP', emailTo: ['evil@example.com'], emailLink: true}}), /admin/i],
    [rest(`/api/v6/translations/d/${A}/w/${W}`, 'POST', {body: {makePublic: true}}), /admin/i],
    // Cross-document references under other key names.
    [rest(`${ps}/features`, 'POST', {body: {feature: {parameters: [{namespace: `d${B}::v${W}::e${E}::m${W}`}]}}}), new RegExp(B)],
    [rest(`/api/v6/documents/d/${A}/w/${W}/e/${E}/x`, 'GET', {query: {documentIds: `${B},${A}`}}), new RegExp(B)],
    // Double decoding, matrix parameters and tabs.
    [rest(`/api/v6/thumbnails/document/${B};x=%252Fd%252F${A}`), /canonical/i],
    [rest(`/api/v6/documents;x=%252Fd%252F${A}/${B.slice(0, 5)}\t${B.slice(5)}`), /canonical/i],
  ]) refused(job, pattern);
  refused({kind: 'native', target: {did: A, wid: W, eid: E}, command: 'ui.assembly.GBTUiAssemblyInsertOccurrence',
    body: {insertables: [{documentId: B, versionId: W, elementId: E}]}}, new RegExp(B));
});

test('default-deny id scan: any 24-hex token outside SAFE_ID_KEYS must be authorized', () => {
  const path = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`;
  refused(rest(path, 'GET', {query: {linkDocumentId: B}}), new RegExp(B));
  refused(rest(path, 'GET', {query: {documentId: [A, B]}}), new RegExp(B));
  refused(rest(path, 'GET', {query: {anything: B}}), new RegExp(B));
  for (const body of [{feature: {parameters: [{namespace: 'x', linkDocumentId: B}]}}, {documentIdSource: B}, {SourceDocumentId: B.toUpperCase()},
    {note: `see ${B} here`}, {href: `https://cad.onshape.com/api/documents/${B}/w/${W}`}, {list: `${A},${B}`}, {[B]: 1},
    {elementId: {documentId: B}}, {ref: `x_${B}`}]) refused(rest(path, 'POST', {body}), new RegExp(B), policy());
  // Deep nesting cannot hide ids.
  let deep = {documentId: B}; for (let i = 0; i < 50; i++) deep = {x: deep};
  refused(rest(path, 'POST', {body: deep}), /nesting/);
  // Non-document ids are allowed under their own keys only.
  allowed(rest(path, 'POST', {body: {feature: {linkDocumentId: A, nodeId: B, featureId: B, importMicroversion: B, parameters: [{documentVersionId: B}]},
    documentId: 'not-an-id', elementId: B, elementIds: [B, C], workspaceId: B, versionId: B, microversionId: B, sourceMicroversion: B,
    partId: B, propertyId: B, groupId: B}}));
  // Version and element namespace parts are not documents; longer hex runs (hashes) are not ids.
  allowed(rest(path, 'POST', {body: {namespace: `d${A}::v${B}::e${C}::m${B}`, hash: 'b'.repeat(40)}}));
});

test('raw bodies: only multipart, with text fields scanned and file parts opaque', () => {
  const upload = `/api/v6/blobelements/d/${A}/w/${W}`;
  allowed(rest(upload, 'POST', form([['encodedFilename', 'part.step']], [['file', `solid ${B} data`]])));
  allowed(rest(upload, 'POST', {...form([['translate', 'true']]), content_type: 'Multipart/Form-Data; boundary="XyZ"'}));
  refused(rest(upload, 'POST', form([['parentDocumentId', B]])), new RegExp(B));
  refused(rest(upload, 'POST', form([['meta', `{"documentId":"${B}"}`]])), new RegExp(B));
  refused(rest(upload, 'POST', form([['isPublic', 'true']])), /admin/i);
  refused(rest(upload, 'POST', form([['ownerId', 'company']])), /admin/i);
  refused(rest(upload, 'POST', form([['meta', '{"makePublic":true}']])), /admin/i);
  refused(rest(upload, 'POST', {...form([['translate', 'true']]), query: {makePublic: 'true'}}), /admin/i);
  allowed(rest(upload, 'POST', form([['isPublic', 'false']])));
  // A fake header inside a text value is not a file part to the server.
  const sneaky = form([['note', `x--XyZ\r\nContent-Disposition: form-data; name="f"; filename="y"\r\n\r\n${B}`]]);
  refused(rest(upload, 'POST', sneaky), new RegExp(B));
  refused(rest(upload, 'POST', form([['a; filename=b', B]])), new RegExp(B));
  refused(rest(upload, 'POST', {content_type: 'multipart/form-data', body_base64: b64('x')}), /multipart/);
  refused(rest(upload, 'POST', {content_type: 'text/plain', body_base64: b64('x')}), /multipart/);
  refused(rest(upload, 'POST', {body_base64: b64('{}')}), /multipart/);
});

test('rest without a path document id is refused except a small allowlist', () => {
  for (const job of [rest('/api/v6/documents'), rest('/api/v6/webhooks', 'POST'), rest(`/api/v6/translations/${C}`, 'POST'),
    rest('/api/folders/x'), rest('/api/v6/users/sessioninfo', 'POST'), rest('/api/v6/documents/search', 'POST'),
    rest(`/api/v6/comments/${E}`), rest(`/api/v6/comments/${E}/attachment`, 'POST', form([], [['file', 'png']])),
    rest('/api/v6/comments'), rest('/api/v6/comments', 'GET', {query: {did: 'not-an-id'}}),
    rest('/api/v6/thumbnails/abc'), rest('/api/v6/translations/translationformats', 'POST')]) refused(job, /no document id/i, policy());
  allowed(rest('/api/users/sessioninfo'));
  allowed(rest('/api/v10/users/sessioninfo'));
  allowed(rest('/api/v10/documents', 'POST', {body: {name: 'New'}}));
  allowed(rest(`/api/v6/translations/${C}`));
  allowed(rest('/api/v6/translations/translationformats'));
  allowed(rest('/api/thumbnails/b2d11bdb54b4bdfb7ccf9a634e69232b80156648'));
  allowed(rest('/api/thumbnails/b2d11bdb54b4bdfb7ccf9a634e69232b80156648/s/300x170'));
  // The comments collection is scoped by its document id, which must be authorized.
  allowed(rest('/api/v6/comments', 'GET', {query: {did: A}}));
  allowed(rest('/api/v6/comments', 'GET', {query: {documentId: A}}));
  allowed(rest('/api/v6/comments', 'POST', {body: {documentId: A, workspaceId: W, elementId: E, message: 'hi'}}));
  refused(rest('/api/v6/comments', 'GET', {query: {did: B}}), /not authorized/);
  refused(rest('/api/v6/comments', 'POST', {body: {documentId: B, message: 'hi'}}), /not authorized/);
});

test('reviewer regressions: legitimate document-scoped endpoints are allowed', () => {
  // structure_service duplicate_element
  allowed(rest(`/api/v6/elements/copyelement/${A}/workspace/${W}`, 'POST', {body: {documentIdSource: A, workspaceIdSource: W, elementIdSource: E}}));
  refused(rest(`/api/v6/elements/copyelement/${A}/workspace/${W}`, 'POST', {body: {documentIdSource: B, workspaceIdSource: W, elementIdSource: E}}), new RegExp(B));
  allowed(rest(`/api/v6/elements/translatorFormats/${A}/w/${W}/${E}`));
  // Document thumbnails render tab content: not an overview read, refused under v2.
  refused(rest(`/api/v6/thumbnails/document/${A}`), /not classified/);
  refused(rest(`/api/v6/thumbnails/document/${A}/version/${W}`), /not classified/);
  allowed(rest('/api/v6/comments', 'GET', {query: {documentId: A}}));
  allowed(rest('/api/v6/translations/translationformats'));
  allowed(rest('/api/thumbnails/b2d11bdb54b4bdfb7ccf9a634e69232b80156648'));
  // api_upload to a document-scoped multipart endpoint.
  allowed(rest(`/api/v6/blobelements/d/${A}/w/${W}`, 'POST', form([['encodedFilename', 'part.step']], [['file', 'solid']])));
  allowed({kind: 'tabs'});
});

test('admin endpoints need per-document admin; segments match exactly', () => {
  for (const [path, method] of [[`/api/v6/documents/${A}/share`, 'POST'], [`/api/v6/documents/${A}/SHARE`, 'POST'],
    [`/api/v6/documents/${A}/share.json`, 'POST'], [`/api/v6/documents/${A}/unshare/${E}`, 'DELETE'], [`/api/v6/documents/${A}/acl`, 'GET'],
    [`/api/v6/documents/${A}/permissionset`, 'GET'], [`/api/v6/documents/d/${A}/publicaccess`, 'POST'],
    [`/api/v6/documents/${A}/webhooks`, 'POST'], [`/api/v6/documents/${A}/owner`, 'POST'], [`/api/v6/documents/${A}/movetofolder`, 'POST'],
    [`/api/v6/documents/${A}`, 'DELETE'], [`/api/documents/d/${A}`, 'DELETE'], [`/api/v6/documents/${A}/sharewithsupport`, 'POST']]) {
    // "permissionset" is not the "permission" segment: not admin, and not a classified route either.
    if (path.endsWith('permissionset')) { refused(rest(path, method), /not classified/, policy(true)); continue; }
    if (path.includes('/unshare/')) { refused(rest(path, method), new RegExp(E)); continue; }  // the entry id is default-denied
    assert.equal(classify(rest(path, method)).admin, true, path);
    hasNeed(rest(path, method), action(A, 'admin'));
    refused(rest(path, method), /admin/i);
    allowed(rest(path, method), policy(true));
  }
  // Ids and unrelated words are never admin by substring.
  assert.equal(classify(rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE')).admin, false);
  assert.equal(classify(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features/featureid/Fowner1`, 'POST')).admin, false);
  allowed(rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE'));
  // Admin on one document never covers another referenced one.
  refused(rest(`/api/v6/documents/${A}/share`, 'POST', {body: {documentId: B}}), /not authorized/, policy(true));
  const both = v2({[A]: {branches: {[W]: {all: 'write'}}, actions: {admin: true}}, [B]: {branches: {[W]: {all: 'write'}}}});
  refused(rest(`/api/v6/documents/${A}/share`, 'POST', {query: {linkDocumentId: B}}), new RegExp(`admin.*${B}|${B}.*admin`, 'i'), both);
});

test('admin body fields need per-document admin; falsy values do not', () => {
  // A whole-branch copy is not admin by itself, so the body fields decide.
  const copy = `/api/v6/documents/${A}/workspaces/${W}/copy`;
  for (const body of [{ownerId: 'x'}, {ownerType: 1}, {parentId: 'f'}, {projectId: 'p'}, {makePublic: true}, {isPublic: 'true'}, {isPublic: 1},
    {publicAccess: true}, {emailTo: ['x@y']}, {emailLink: true}, {anonymousAllowsExport: true}, {shareAction: 'x'}, {nested: [{EmailMessage: 'hi'}]}]) {
    assert.equal(classify(rest(copy, 'POST', {body})).admin, true, JSON.stringify(body));
    refused(rest(copy, 'POST', {body}), /admin/i);
    allowed(rest(copy, 'POST', {body}), policy(true));
  }
  for (const body of [{isPublic: false}, {makePublic: false}, {emailTo: []}, {emailLink: false}, {ownerType: 0}, {parentId: null}, {name: 'owner'}])
    assert.equal(classify(rest(copy, 'POST', {body})).admin, false, JSON.stringify(body));
  // Document attributes are admin whatever the body says.
  assert.equal(classify(rest(`/api/v6/documents/${A}`, 'POST', {body: {name: 'x'}})).admin, true);
  // GET queries carry no admin fields; createDocument with admin fields names no authorized document.
  assert.equal(classify(rest(`/api/v6/documents/${A}`, 'GET', {query: {ownerId: 'x'}})).admin, false);
  refused(rest('/api/v6/documents', 'POST', {body: {name: 'x', isPublic: true}}), /admin/i, policy(true));
  refused(rest('/api/v6/documents', 'POST', {body: {name: 'x', parentId: 'folder'}}), /admin/i, policy(true));
  allowed(rest('/api/v6/documents', 'POST', {body: {name: 'x', isPublic: false}}));
});

test('tabs are never refused and malformed policy fails closed', () => {
  // Default parameters would swallow `undefined`; call authorize directly.
  assert.doesNotThrow(() => authorize({kind: 'tabs'}, undefined));
  assert.throws(() => authorize(rest(`/api/v6/documents/${A}`), undefined), /not authorized/);
  // authorize takes the effective (v2) policy; anything else, including a raw v1 policy, fails closed.
  for (const bad of [null, 'x', [], {docs: []}, {docs: {[A]: true}}, {docs: null}, {docs: {[A]: {admin: true}}},
    {version: 2, docs: {[A]: true}}, {version: 2, docs: {[A]: {branches: []}}}]) refused({kind: 'tabs'}, /policy/i, bad);
});

test('worker overwrites bridge-supplied trust fields from policy', () => {
  const job = {kind: 'state', target: {did: A, wid: W, eid: E}, admin_allowed: true, allow_untested_native: true};
  const trusted = applyPolicy(job, policy());
  assert.equal(trusted.admin_allowed, false); assert.equal(trusted.allow_untested_native, false);
  assert.equal(job.admin_allowed, true, 'input job is not mutated');
  const elevated = applyPolicy(job, policy(true, {allow_untested_native: true}));
  assert.equal(elevated.admin_allowed, true); assert.equal(elevated.allow_untested_native, true);
  assert.equal(applyPolicy({kind: 'tabs', admin_allowed: true}, policy(true)).admin_allowed, false);
  assert.throws(() => applyPolicy({...job, target: {did: B, wid: W, eid: E}}, policy(true)), new RegExp(B));
});

test('effective policy merges worker-created documents under popup entries', () => {
  const created = {docs: {[C]: createdDoc}};
  const merged = effectivePolicy({version: 2, docs: {[A]: {branches: {[W]: {all: 'read'}}}}}, created);
  assert.deepEqual(Object.keys(merged.docs).sort(), [A, C]);
  allowed(rest(`/api/v6/documents/${C}`), merged);
  // The popup's entry (e.g. an admin toggle on a created document) wins.
  assert.equal(effectivePolicy({version: 2, docs: {[C]: {actions: {admin: true}}}}, created).docs[C].actions.admin, true);
  assert.deepEqual(effectivePolicy(undefined, undefined).docs, {});
  for (const bad of [null, [], {docs: {[C]: true}}]) assert.throws(() => effectivePolicy({version: 2, docs: {}}, bad), /policy/i);
});

test('created and copied documents are auto-authorized only after success from an authorized source', () => {
  // recordCreated keeps its v1 output until Task 4; only the copy-source check moved to v2 grants.
  const popup = {version: 2, docs: {[A]: {branches: {[W]: {all: 'read'}}}}};
  const create = rest('/api/v10/documents', 'POST', {body: {name: 'New'}});
  const added = recordCreated(create, {status: 200, body: {id: C}}, popup, {}, 5);
  assert.deepEqual(added, {[C]: {admin: false, source: 'created', added: 5}}, 'returns only the created map');
  const prior = {[B]: {admin: false, source: 'created', added: 1}};
  assert.deepEqual(Object.keys(recordCreated(create, {status: 200, body: {id: C}}, popup, prior, 5)).sort(), [B, C]);
  const copy = rest(`/api/v6/documents/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'Copy'}});
  assert.deepEqual(recordCreated(copy, {status: 200, body: {newDocumentId: C}}, popup, {}, 5)[C], {admin: false, source: 'created', added: 5});
  // A copy of a created document counts as authorized too.
  const fromB = rest(`/api/v6/documents/${B}/workspaces/${W}/copy`, 'POST');
  assert.equal(recordCreated(fromB, {status: 200, body: {newDocumentId: C}}, popup), null);
  assert.ok(recordCreated(fromB, {status: 200, body: {newDocumentId: C}}, popup, {docs: {[B]: createdDoc}})[C]);
  // A document entry without any grant is not an authorized source.
  assert.equal(recordCreated(fromB, {status: 200, body: {newDocumentId: C}}, {version: 2, docs: {[B]: {actions: {tabs: true}}}}), null);
  assert.equal(recordCreated(create, {status: 403, body: {id: C}}, popup), null);
  assert.equal(recordCreated(create, {error: 'failed'}, popup), null);
  assert.equal(recordCreated(create, {status: 200, body: {id: 'not-hex'}}, popup), null);
  assert.equal(recordCreated(rest('/api/v10/documents'), {status: 200, body: {id: C}}, popup), null);
  assert.equal(recordCreated(rest(`/api/v6/documents/${A}/workspaces/${W}`, 'POST'), {status: 200, body: {id: C}}, popup), null);
});

test('document names are bounded optional strings, labelled "name — id"', () => {
  assert.equal(docName(`  ${'x'.repeat(200)}  `), 'x'.repeat(120));
  assert.equal(docName('  Gearbox | Onshape '), 'Gearbox | Onshape');
  for (const bad of [undefined, null, 5, {}]) assert.equal(docName(bad), '');
  assert.equal(docLabel(A, {name: 'Gearbox'}), `Gearbox — ${A}`);
  assert.equal(docLabel(A, {}), A);
  // Optional name keeps entries valid; a non-string name is malformed.
  assert.doesNotThrow(() => authorize(rest(`/api/v6/documents/${A}`), v2({[A]: {name: 'Gearbox', branches: {[W]: {tabs: {[E]: {mode: 'read'}}}}}})));
  assert.throws(() => v2({[A]: {name: 5}}), /policy/i);
  assert.throws(() => effectivePolicy({version: 2, docs: {}}, {docs: {[C]: {name: ['x']}}}), /policy/i);
  const popup = {version: 2, docs: {[A]: {branches: {[W]: {all: 'read'}}}}};
  const copy = rest(`/api/v6/documents/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'Copy'}});
  assert.deepEqual(recordCreated(copy, {status: 200, body: {newDocumentId: C, newDocumentName: ' Copy of X '}}, popup, {}, 5)[C],
    {admin: false, source: 'created', added: 5, name: 'Copy of X'});
  const create = rest('/api/v10/documents', 'POST', {body: {name: 'New'}});
  assert.equal(recordCreated(create, {status: 200, body: {id: C, name: 'New'}}, popup, {}, 5)[C].name, 'New');
});

test('tab URLs map to document ids and targets', () => {
  assert.equal(didFromUrl(`https://cad.onshape.com/documents/${A}/w/${W}/e/${E}`), A);
  assert.equal(didFromUrl('https://cad.onshape.com/documents'), null);
  assert.equal(didFromUrl(`https://evil.example/documents/${A}/w/${W}`), null);
  assert.equal(didFromUrl(undefined), null);
  assert.deepEqual(targetFromUrl(`https://cad.onshape.com/documents/${A}/w/${W}/e/${E}`), {did: A, wvm: 'w', wvmid: W, eid: E});
  assert.deepEqual(targetFromUrl(`https://cad.onshape.com/documents/${A}/v/${V}/e/${E}?x=1`), {did: A, wvm: 'v', wvmid: V, eid: E});
  assert.deepEqual(targetFromUrl(`https://cad.onshape.com/documents/${A}/m/${V}`), {did: A, wvm: 'm', wvmid: V, eid: null});
  for (const url of [`https://cad.onshape.com/documents/${A}`, `https://evil.example/documents/${A}/w/${W}/e/${E}`,
    `https://cad.onshape.com.evil.example/documents/${A}/w/${W}`, `https://cad.onshape.com/documents/${A}/x/${W}`, 'nope', undefined])
    assert.equal(targetFromUrl(url), null, String(url));
});

// ---- Task 2: classification into needs ----

test('element paths map to tab needs', () => {
  const ps = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`;
  needs(rest(ps), [tab(A, W, E, 'read')]);
  needs(rest(ps, 'POST', {body: {}}), [tab(A, W, E, 'write')]);
  needs(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features/featureid/F1`, 'DELETE'), [tab(A, W, E, 'write')]);
  // Versions and microversions are history: read on the tab in any branch, never a write.
  for (const wvm of ['v', 'm']) {
    needs(rest(`/api/v6/partstudios/d/${A}/${wvm}/${V}/e/${E}/features`), [tab(A, null, E, 'read')]);
    assert.throws(() => classify(rest(`/api/v6/partstudios/d/${A}/${wvm}/${V}/e/${E}/features`, 'POST', {body: {}})), /workspace/);
    assert.throws(() => classify(rest(`/api/v6/metadata/d/${A}/${wvm}/${V}/e/${E}`, 'POST', {body: {}})), /workspace/);
  }
  // Paths without a branch segment are read-only too.
  needs(rest(`/api/v6/partstudios/d/${A}/e/${E}/namedViews`), [tab(A, null, E, 'read')]);
  assert.throws(() => classify(rest(`/api/v6/partstudios/d/${A}/e/${E}/namedViews`, 'POST')), /workspace/);
  needs(rest(`/api/v6/elements/translatorFormats/${A}/v/${V}/${E}`), [tab(A, null, E, 'read')]);
  needs(rest(`/api/v6/elements/translatorFormats/${A}/w/${W}/${E}`), [tab(A, W, E, 'read')]);
  // Tab deletion and BOM creation also need the tabs action.
  needs(rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE'), [tab(A, W, E, 'write'), action(A, 'tabs')]);
  needs(rest(`/api/v6/assemblies/d/${A}/w/${W}/e/${E}/bomelement`, 'POST'), [tab(A, W, E, 'read'), action(A, 'tabs')]);
  // Element metadata holds the tab name: renaming a tab is a tabs action.
  needs(rest(`/api/v6/metadata/d/${A}/w/${W}/e/${E}`, 'POST', {body: {}}), [tab(A, W, E, 'write'), action(A, 'tabs')]);
  needs(rest(`/api/v6/metadata/d/${A}/w/${W}/e/${E}`), [tab(A, W, E, 'read')]);
  // A second element in the path is never ignored.
  assert.throws(() => classify(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/x/e/${E2}`)), /not classified/);
  // An admin segment never classifies a path that names an element; only /api/ paths are classified.
  assert.throws(() => classify(rest(`/api/v6/partstudios/d/${A}/w/${W}/share/e/${E2}`, 'POST')), /not classified/);
  assert.throws(() => classify(rest(`/documents/${A}`)), /api/);
  // Unknown methods are refused.
  assert.throws(() => classify(rest(ps, 'get')), /method/);
  assert.throws(() => classify(rest(ps, 'HEAD')), /method/);
});

test('read-only POSTs are reads', () => {
  for (const tail of ['featurescript', 'idtranslations', 'export', 'export/gltf', 'export/obj', 'export/step', 'translations', 'content/jsonpaths']) {
    needs(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/${tail}`, 'POST', {body: {}}), [tab(A, W, E, 'read')], tail);
    needs(rest(`/api/v6/partstudios/d/${A}/v/${V}/e/${E}/${tail}`, 'POST', {body: {}}), [tab(A, null, E, 'read')], tail);
    // Read-only POSTs are POST only.
    needs(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/${tail}`, 'DELETE'), [tab(A, W, E, 'write')], tail);
  }
  needs(rest(`/api/v6/elements/d/${A}/e/${E}/configurationencodings`, 'POST', {body: {}}), [tab(A, null, E, 'read')]);
  // A translation stored in the document creates a tab.
  const tr = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}/translations`;
  needs(rest(tr, 'POST', {body: {storeInDocument: false}}), [tab(A, W, E, 'read')]);
  needs(rest(tr, 'POST', {body: {storeInDocument: 'false'}}), [tab(A, W, E, 'read')]);
  for (const v of [true, 'true', 1]) needs(rest(tr, 'POST', {body: {storeInDocument: v}}), [tab(A, W, E, 'write'), action(A, 'tabs')]);
  needs(rest(tr, 'POST', {body: {StoreInDocument: true}}), [tab(A, W, E, 'write'), action(A, 'tabs')]);
  assert.throws(() => classify(rest(`/api/v6/partstudios/d/${A}/v/${V}/e/${E}/translations`, 'POST', {body: {storeInDocument: true}})), /workspace/);
});

test('document routes are classified', () => {
  const d = `/api/v6/documents`;
  for (const path of [`${d}/${A}`, `${d}/d/${A}/w/${W}/contents`, `${d}/d/${A}/v/${V}/elements`, `${d}/d/${A}/m/${V}/unitinfo`,
    `${d}/d/${A}/w/${W}/currentmicroversion`, `${d}/d/${A}/v/${V}/insertables`, `${d}/d/${A}/w/${W}/documenthistory`,
    `${d}/d/${A}/versions`, `${d}/d/${A}/versions/${V}`, `${d}/d/${A}/workspaces`, `${d}/${A}/w/${W}/mergePreview`,
    `/api/v6/appelements/d/${A}/w/${W}/resolvereferences`, `/api/v6/metadata/d/${A}/v/${V}/e`, `/api/v6/insertables/d/${A}/latest`,
    `${d}/d/${A}/externaldata/${C}`]) needs(rest(path), [overview(A)], path);
  needs(rest(`${d}/d/${A}/versions`, 'POST', {body: {name: 'V1'}}), [overview(A), action(A, 'versions')]);
  needs(rest(`${d}/d/${A}/workspaces`, 'POST', {body: {name: 'b'}}), [overview(A), action(A, 'branches')]);
  const merge = classify(rest(`${d}/${A}/workspaces/${W}/merge`, 'POST', {body: {}}));
  assert.equal(merge.critical, 'merge');
  needs(rest(`${d}/${A}/workspaces/${W}/merge`, 'POST', {body: {}}), [action(A, 'merge'), branch(A, W, 'write')]);
  for (const vm of ['v', 'm']) {
    assert.equal(classify(rest(`${d}/${A}/w/${W}/restore/${vm}/${V}`, 'POST')).critical, 'restore');
    needs(rest(`${d}/${A}/w/${W}/restore/${vm}/${V}`, 'POST'), [action(A, 'merge'), branch(A, W, 'write')]);
  }
  for (const path of [`/api/v6/partstudios/d/${A}/w/${W}`, `/api/v6/assemblies/d/${A}/w/${W}`, `/api/v6/featurestudios/d/${A}/w/${W}`,
    `/api/v6/blobelements/d/${A}/w/${W}`, `/api/v6/variables/d/${A}/w/${W}/variablestudio`, `/api/v6/drawings/d/${A}/w/${W}/create`,
    `/api/v6/translations/d/${A}/w/${W}`]) needs(rest(path, 'POST', {body: {}}), [overview(A), action(A, 'tabs')], path);
  needs(rest(`/api/v6/elements/copyelement/${A}/workspace/${W}`, 'POST', {body: {documentIdSource: B, workspaceIdSource: W2, elementIdSource: E2}}),
    [overview(A), action(A, 'tabs'), tab(B, null, E2, 'read')]);
  needs(rest(`${d}/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'x'}}), [branch(A, W, 'read')]);
  for (const [path, method] of [[`${d}/${A}`, 'POST'], [`${d}/${A}/notes`, 'POST'], [`${d}/d/${A}/w/${W}/moveelement`, 'POST'],
    [`${d}/${A}`, 'DELETE'], [`${d}/${A}/share`, 'POST']]) {
    const c = classify(rest(path, method, {body: {}}));
    assert.equal(c.admin, true, path);
    needs(rest(path, method, {body: {}}), [overview(A), action(A, 'admin')], path);
  }
  // No critical flag outside merge/restore.
  assert.equal(classify(rest(`${d}/d/${A}/versions`, 'POST', {body: {}})).critical, undefined);
});

test('unlisted document routes are refused', () => {
  const d = `/api/v6/documents`;
  for (const [path, method] of [[`${d}/d/${A}/w/${W}/frobnicate`, 'POST'], [`${d}/d/${A}/workspaces/${W}`, 'DELETE'],
    [`/api/v6/metadata/d/${A}/w/${W}`, 'POST'], [`/api/v6/metadata/d/${A}/v/${V}`, 'POST'], [`${d}/d/${A}/w/${W}/revertunchangedtorevisions`, 'POST'],
    [`${d}/d/${A}/w/${W}/syncAppElements`, 'POST'], [`/api/v6/appelements/d/${A}/w/${W}`, 'POST'], [`/api/v6/appelements/d/${A}/w/${W}/bulkcreate`, 'POST'],
    [`/api/v6/appelements/d/${A}/w/${W}/transactions`, 'POST'], [`/api/v6/parts/d/${A}/w/${W}`, 'GET'], [`${d}/d/${A}/w/${W}`, 'GET'],
    [`/api/v6/thumbnails/d/${A}/w/${W}`, 'GET'], [`${d}/${A}/workspaces/${W}/merge`, 'GET'], [`${d}/d/${A}/versions`, 'DELETE']]) {
    assert.throws(() => classify(rest(path, method, {body: {}})), /not classified/, `${method} ${path}`);
    refused(rest(path, method, {body: {}}), /not classified/, policy(true));
  }
});

test('element ids hidden in bodies are needs', () => {
  const asm = `/api/v6/assemblies/d/${A}/w/${W}/e/${E}/instances`;
  // Assembly createInstance: the inserted tab is a read need in any branch.
  needs(rest(asm, 'POST', {body: {documentId: A, elementId: E2, versionId: V}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read')]);
  needs(rest(asm, 'POST', {body: {documentId: B, elementId: E2}}), [tab(A, W, E, 'write'), tab(B, null, E2, 'read')]);
  // No documentId: the request's document. Keys are case-insensitive, lists and arrays are split.
  needs(rest(asm, 'POST', {body: {ElementID: E2}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read')]);
  needs(rest(asm, 'POST', {body: {elementIds: `${E2},${C}`}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read'), tab(A, null, C, 'read')]);
  needs(rest(asm, 'POST', {body: {items: [{elementIds: [E2]}]}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read')]);
  // Derived feature namespaces, with or without a document part.
  const ps = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`;
  needs(rest(ps, 'POST', {body: {feature: {parameters: [{namespace: `d${B}::v${V}::e${E2}::m${V}`}]}}}),
    [tab(A, W, E, 'write'), tab(B, null, E2, 'read')]);
  needs(rest(ps, 'POST', {body: {feature: {parameters: [{namespace: `e${E2}::m${V}`}]}}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read')]);
  // An "e<id>" token outside a namespace field is still an element reference.
  needs(rest(ps, 'POST', {body: {anything: `x e${E2}`}}), [tab(A, W, E, 'write'), tab(A, null, E2, 'read')]);
  // A reference object's documentId scopes its namespaces too.
  hasNeed(rest(ps, 'POST', {body: {documentId: B, namespace: `e${E2}::m${V}`}}), tab(B, null, E2, 'read'));
  // Query strings and multipart fields.
  needs(rest(ps, 'GET', {query: {elementId: E2}}), [tab(A, W, E, 'read'), tab(A, null, E2, 'read')]);
  hasNeed(rest(`/api/v6/blobelements/d/${A}/w/${W}`, 'POST', form([['elementId', E2]])), tab(A, null, E2, 'read'));
  hasNeed(rest(`/api/v6/blobelements/d/${A}/w/${W}`, 'POST', form([['meta', `{"documentId":"${B}","elementId":"${E2}"}`]])), tab(B, null, E2, 'read'));
  // copyelement source.
  hasNeed(rest(`/api/v6/elements/copyelement/${A}/workspace/${W}`, 'POST', {body: {documentIdSource: A, elementIdSource: E2}}), tab(A, null, E2, 'read'));
  // Native insert.
  const insert = {kind: 'native', target: {did: A, wid: W, eid: E}, command: 'ui.assembly.GBTUiAssemblyInsertOccurrence',
    body: {insertables: [{documentId: B, versionId: V, elementId: E2}, {namespace: `d${C}::v${V}::e${E2}`}]}};
  needs(insert, [tab(A, W, E, 'write'), tab(B, null, E2, 'read'), tab(C, null, E2, 'read')]);
  // Without any document to scope it, an element reference is refused.
  assert.throws(() => classify(rest('/api/v6/comments', 'POST', {body: {elementId: E2, message: 'x'}})), /no document id/);
  // Authorization: a tab-only grant refuses a reference to another tab of the same document.
  const only = v2({[A]: {branches: {[W]: {tabs: {[E]: {mode: 'write'}}}}}});
  refused(rest(asm, 'POST', {body: {documentId: A, elementId: E2}}), new RegExp(`tab ${E2}.*document ${A}`), only);
  allowed(rest(asm, 'POST', {body: {documentId: A, elementId: E}}), only);
  refused(rest(ps, 'POST', {body: {namespace: `e${E2}::m${V}`}}), new RegExp(E2), only);
});

test('native commands map to modes', () => {
  const native = (command, body = {}) => ({kind: 'native', target: {did: A, wid: W, eid: E}, command, body});
  needs(native('ui.GBTUiMassPropCall'), [tab(A, W, E, 'read')]);
  needs(native('ui.GBTUiCommit'), [tab(A, W, E, 'write')]);
  needs(native('ui.document.GBTUiEditElementGroups'), [tab(A, W, E, 'write'), action(A, 'tabs')]);
  for (const c of ['ui.document.GBTUiDeleteElements', 'ui.document.GBTUiCopyElements', 'ui.document.GBTUiRenameElement', 'ui.document.GBTUiInsertElement'])
    hasNeed(native(c), action(A, 'tabs'));
  // Branch, version and document-level commands are refused; mirroring creates derived tabs.
  for (const c of ['ui.document.GBTUiUpgradeWorkspaceCall', 'ui.GBTUiWorkspaceRenamed', 'ui.assembly.GBTUiCreateExternalReferenceVersion', 'ui.GBTUiDocumentRenamed'])
    assert.throws(() => classify(native(c)), /refused/, c);
  hasNeed(native('ui.GBTUiAssemblyMirrorCreateDerivedElements'), action(A, 'tabs'));
  // An unknown or non-string command is a write.
  needs(native(undefined), [tab(A, W, E, 'write')]);
  for (const kind of ['state', 'schema', 'open', 'display', 'ui_inspect']) needs({kind, target: {did: A, wid: W, eid: E}}, [tab(A, W, E, 'read')], kind);
  needs({kind: 'ui_action', target: {did: A, wid: W, eid: E}}, [tab(A, W, E, 'write')]);
  needs({kind: 'tabs'}, []);
  // The extension's read list mirrors onshape_native/native_catalog.py READS (sync test in Task 6).
  assert.equal(NATIVE_READS.size, 8);
});

// ---- Task 3: authorization against grants ----

test('tab grant read vs write', () => {
  const ps = `/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`;
  const read = v2({[A]: {branches: {[W]: {tabs: {[E]: {mode: 'read'}}}}}});
  allowed(rest(ps), read);
  allowed({kind: 'state', target: {did: A, wid: W, eid: E}}, read);
  refused(rest(ps, 'POST', {body: {}}), new RegExp(`No write access to tab ${E} in branch ${W} of document ${A}\\. An access request was filed`), read);
  refused({kind: 'native', target: {did: A, wid: W, eid: E}, command: 'ui.GBTUiCommit', body: {}}, /No write access/, read);
  const write = v2({[A]: {branches: {[W]: {tabs: {[E]: {mode: 'write'}}}}}});
  allowed(rest(ps, 'POST', {body: {}}), write);
  allowed(rest(ps), write);
  // Other tab of the same branch.
  refused(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E2}/features`), new RegExp(`No read access to tab ${E2}`), write);
  // The thrown error names the first unmet need.
  try { authorize(rest(ps, 'POST', {body: {}}), read); assert.fail('not refused'); }
  catch (error) { assert.ok(error instanceof AccessError); assert.deepEqual(error.need, tab(A, W, E, 'write')); }
});

test('branch isolation', () => {
  const p = v2({[A]: {branches: {[W]: {tabs: {[E]: {mode: 'write'}}}}}});
  allowed(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`, 'POST', {body: {}}), p);
  refused(rest(`/api/v6/partstudios/d/${A}/w/${W2}/e/${E}/features`, 'POST', {body: {}}), new RegExp(`branch ${W2}`), p);
  refused(rest(`/api/v6/partstudios/d/${A}/w/${W2}/e/${E}/features`), new RegExp(`No read access to tab ${E} in branch ${W2}`), p);
  refused({kind: 'native', target: {did: A, wid: W2, eid: E}, command: 'ui.GBTUiMassPropCall', body: {}}, /No read access/, p);
  // History of the granted tab is readable from any version.
  allowed(rest(`/api/v6/partstudios/d/${A}/v/${V}/e/${E}/features`), p);
  allowed(rest(`/api/v6/partstudios/d/${A}/m/${V}/e/${E}/featurescript`, 'POST', {body: {}}), p);
  // A whole-branch grant on W says nothing about W2.
  const whole = v2({[A]: {branches: {[W]: {all: 'write'}}}});
  allowed(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E2}/features`, 'POST', {body: {}}), whole);
  refused(rest(`/api/v6/partstudios/d/${A}/w/${W2}/e/${E2}/features`), /No read access/, whole);
});

test('history reads need a grant on any branch', () => {
  const p = v2({[A]: {branches: {[W2]: {tabs: {[E]: {mode: 'read'}}}}}});
  allowed(rest(`/api/v6/partstudios/d/${A}/v/${V}/e/${E}/features`), p);
  refused(rest(`/api/v6/partstudios/d/${A}/v/${V}/e/${E2}/features`), new RegExp(`No read access to tab ${E2} in any branch of document ${A}`), p);
  refused(rest(`/api/v6/partstudios/d/${B}/v/${V}/e/${E}/features`), new RegExp(`document ${B}`), p);
  // A whole-branch read covers history of every tab.
  allowed(rest(`/api/v6/partstudios/d/${A}/m/${V}/e/${E2}/features`), v2({[A]: {branches: {[W]: {all: 'read'}}}}));
});

test('overview needs any grant', () => {
  const contents = rest(`/api/v6/documents/d/${A}/w/${W}/contents`);
  allowed(contents, v2({[A]: {branches: {[W2]: {tabs: {[E]: {mode: 'read'}}}}}}));
  allowed(rest(`/api/v6/documents/d/${A}/versions`), v2({[A]: {branches: {[W]: {all: 'read'}}}}));
  // An entry with actions but no grant, or another document's grant, is not enough.
  refused(contents, new RegExp(`Document ${A} is not authorized`), v2({[A]: {actions: {versions: true}}}));
  refused(contents, /not authorized/, v2({[B]: {branches: {[W]: {all: 'write'}}}}));
  // A document id in a body needs a grant on that document.
  refused(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features`, 'POST', {body: {linkDocumentId: B}}), new RegExp(`Document ${B}`),
    v2({[A]: {branches: {[W]: {all: 'write'}}}}));
});

test('each action toggle', () => {
  const grant = actions => v2({[A]: {branches: {[W]: {all: 'write'}}, actions}});
  for (const [job, name] of [[rest(`/api/v6/documents/d/${A}/versions`, 'POST', {body: {}}), 'versions'],
    [rest(`/api/v6/documents/d/${A}/workspaces`, 'POST', {body: {}}), 'branches'],
    [rest(`/api/v6/partstudios/d/${A}/w/${W}`, 'POST', {body: {}}), 'tabs'],
    [rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE'), 'tabs'],
    [{kind: 'native', target: {did: A, wid: W, eid: E}, command: 'ui.document.GBTUiRenameElement', body: {}}, 'tabs']]) {
    refused(job, new RegExp(`Document action "${name}" is off for ${A}\\. Ask the user to enable it in the popup`), grant({}));
    try { authorize(job, grant({})); } catch (error) { assert.deepEqual(error.need, action(A, name)); }
    allowed(job, grant({[name]: true}));
    // Another action's toggle does not help.
    refused(job, /is off/, grant(Object.fromEntries(['versions', 'branches', 'tabs'].filter(a => a !== name).map(a => [a, true]))));
  }
});

test('merge needs toggle, whole-branch write and approval', () => {
  const merge = rest(`/api/v6/documents/${A}/workspaces/${W}/merge`, 'POST', {body: {workspaceId: W2}});
  const key = jobKey(merge);
  const ok = {[key]: 2000};
  const p = (actions, branches = {[W]: {all: 'write'}}) => v2({[A]: {branches, actions}});
  refused(merge, /"merge" is off/, p({}), ok, [], 1000);
  refused(merge, /whole branch/, p({merge: true}, {[W]: {tabs: {[E]: {mode: 'write'}}}}), ok, [], 1000);
  refused(merge, /whole branch/, p({merge: true}, {[W]: {all: 'read'}}), ok, [], 1000);
  refused(merge, /whole branch/, p({merge: true}, {[W2]: {all: 'write'}}), ok, [], 1000);
  // Approval: missing, expired, consumed, or for another body.
  for (const [approvals, consumed, now] of [[{}, [], 1000], [ok, [], 2000], [ok, [key], 1000],
    [{[jobKey({...merge, body: {workspaceId: W}})]: 2000}, [], 1000], [ok, 'not-a-list', 1000]]) {
    try { authorize(merge, p({merge: true}), approvals, consumed, now); assert.fail('not refused'); }
    catch (error) {
      assert.ok(error instanceof AccessError, error.message);
      assert.deepEqual(error.need, {did: A, type: 'approval', critical: 'merge', key});
      assert.match(error.message, /approv/);
    }
  }
  assert.deepEqual(authorize(merge, p({merge: true}), ok, [], 1000).approvalKey, key);
  assert.equal(applyPolicy(merge, p({merge: true}), ok, [], 1000).method, 'POST');
  // Restore is critical the same way.
  const restore = rest(`/api/v6/documents/${A}/w/${W}/restore/v/${V}`, 'POST');
  refused(restore, /approv/, p({merge: true}), {}, [], 1000);
  allowed(restore, p({merge: true}), {[jobKey(restore)]: 2000}, [], 1000);
  // Non-critical jobs have no approval key.
  assert.equal(authorize(rest(`/api/v6/documents/d/${A}/versions`, 'POST', {body: {}}), p({versions: true})).approvalKey, undefined);
  // Raw bodies cannot be bound to an approval.
  assert.throws(() => classify({...merge, body: null, ...form([['workspaceId', W2]])}), /raw/i);
});

test('jobKey is stable JSON of method, path, query and body', () => {
  const a = jobKey({kind: 'rest', method: 'POST', path: '/x', query: {b: 1, a: 2}, body: {y: [1, {d: 1, c: 2}], x: null}, tab_id: 3});
  const b = jobKey({body: {x: null, y: [1, {c: 2, d: 1}]}, query: {a: 2, b: 1}, path: '/x', method: 'POST', kind: 'rest'});
  assert.equal(a, b);
  assert.equal(a, '{"body":{"x":null,"y":[1,{"c":2,"d":1}]},"method":"POST","path":"/x","query":{"a":2,"b":1}}');
  assert.notEqual(jobKey({method: 'POST', path: '/x', query: {}, body: {}}), jobKey({method: 'POST', path: '/x', query: {}, body: {z: 1}}));
});

test('catalog versioning endpoints refused by default', () => {
  const spec = JSON.parse(fs.readFileSync(new URL('../data/openapi.json', import.meta.url), 'utf8'));
  const ids = {did: A, wid: W, eid: E};
  const fill = path => path.replace(/\{(wvm|wv|wm)\}/g, 'w').replace(/\{vm\}/g, 'v').replace(/\{(\w+)\}/g, (_, n) => ids[n] ?? C);
  const p = v2({[A]: {branches: {[W]: {all: 'write'}}}});
  let checked = 0;
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!/versions|workspaces|merge|restore|revert/i.test(path)) continue;
    for (const method of Object.keys(ops).filter(m => ['post', 'put', 'patch', 'delete'].includes(m))) {
      // A workspace copy creates a new document and changes nothing here: it needs a whole-branch read (Task 4 records it).
      if (ops[method].operationId === 'copyWorkspace') { allowed(rest(`/api/v10${fill(path)}`, 'POST', {body: {}}), p); continue; }
      refused(rest(`/api/v10${fill(path)}`, method.toUpperCase(), {body: {}}), /not classified|is off|approv|workspace/, p);
      checked++;
    }
  }
  assert.ok(checked >= 6, `checked ${checked}`);
});

test('admin unchanged: the admin document action', () => {
  const share = rest(`/api/v6/documents/${A}/share`, 'POST', {body: {}});
  refused(share, /Admin action \(share endpoint\) on document/, v2({[A]: {branches: {[W]: {all: 'write'}}, actions: {tabs: true, versions: true}}}));
  allowed(share, v2({[A]: {branches: {[W]: {tabs: {[E]: {mode: 'read'}}}}, actions: {admin: true}}}));
  // Admin without any grant on the document is still refused.
  refused(share, /not authorized/, v2({[A]: {actions: {admin: true}}}));
  assert.equal(applyPolicy({kind: 'state', target: {did: A, wid: W, eid: E}}, v2({[A]: {branches: {[W]: {all: 'read'}}, actions: {admin: true}}})).admin_allowed, true);
});
