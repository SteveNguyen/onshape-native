import test from 'node:test';
import assert from 'node:assert/strict';
import {classify, authorize, applyPolicy, recordCreated, effectivePolicy, didFromUrl, docName, docLabel} from '../extension/policy.js';

const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24), W = 'e'.repeat(24), E = 'f'.repeat(24);
const policy = (admin = false, extra = {}) => ({docs: {[A]: {admin, source: 'user', added: 1}}, allow_untested_native: false, ...extra});
const rest = (path, method = 'GET', more = {}) => ({kind: 'rest', method, path, query: {}, body: null, ...more});
const allowed = (job, p = policy()) => assert.doesNotThrow(() => authorize(job, p));
const refused = (job, pattern, p = policy()) => assert.throws(() => authorize(job, p), pattern);
const b64 = text => Buffer.from(text, 'latin1').toString('base64');
// Multipart body as httpx/browsers encode it: CRLF before every delimiter.
const form = (fields = [], files = [], boundary = 'XyZ') => {
  let text = '';
  for (const [name, value] of fields) text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  for (const [name, value] of files) text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="a.step"\r\nContent-Type: application/octet-stream\r\n\r\n${value}\r\n`;
  return {content_type: `multipart/form-data; boundary=${boundary}`, body_base64: b64(text + `--${boundary}--\r\n`)};
};

test('targeted kinds use target.did', () => {
  const ui = policy(false, {allow_ui_fallback: true});
  for (const kind of ['native', 'state', 'schema', 'open', 'ui_inspect', 'ui_action', 'display']) {
    assert.deepEqual(classify({kind, target: {did: A, wid: W, eid: E}}).dids, [A]);
    allowed({kind, target: {did: A, wid: W, eid: E}}, ui);
    refused({kind, target: {did: B, wid: W, eid: E}}, new RegExp(`Document ${B} is not authorized.*popup`), ui);
  }
  assert.throws(() => classify({kind: 'state'}));
  assert.throws(() => classify({kind: 'unknown'}));
});

test('externaldata file ids are not documents (live STEP export download)', () => {
  allowed(rest(`/api/v10/documents/d/${A}/externaldata/${C}`));
  refused(rest(`/api/v10/documents/d/${B}/externaldata/${C}`), new RegExp(`Document ${B} is not authorized`));
});

test('UI fallback needs its own popup opt-in, even with admin', () => {
  for (const kind of ['ui_inspect', 'ui_action']) {
    refused({kind, target: {did: A, wid: W, eid: E}}, /UI fallback.*popup/, policy(true));
    refused({kind, target: {did: A, wid: W, eid: E}}, /UI fallback/, policy(true, {allow_ui_fallback: 'true'}));
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
    `/api/v6/documents/d/${A}/w/${W}`, `/api/v6/partstudios/D/${A.toUpperCase()}/w/${W}`,
    `/api/v6/partstudios/d%2F${A}%2Fw%2F${W}`, `/api/documents//${A}`]) {
    assert.deepEqual(classify(rest(path)).dids, [A], path);
    allowed(rest(path));
  }
  for (const path of [`/api/v6/partstudios/d%2F${B}%2Fw`, `/api/v6/partstudios/D/${B.toUpperCase()}/w/${W}`,
    `/api/v6/documents/${A}/d/${B}`, `/api/v6/documents/${A}/x/${B}`, `/api/v6/thumbnails/document/${B}`,
    `/api/v6/elements/copyelement/${B}/workspace/${W}`, `/api/v6/elements/translatorFormats/${B}/w/${W}/${E}`]) refused(rest(path), /not authorized/);
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
  allowed(rest(`/api/v6/thumbnails/document/${A}`));
  allowed(rest(`/api/v6/thumbnails/document/${A}/version/${W}`));
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
    if (path.endsWith('permissionset')) { allowed(rest(path, method)); continue; }
    if (path.includes('/unshare/')) { refused(rest(path, method), new RegExp(E)); continue; }  // the entry id is default-denied
    assert.equal(classify(rest(path, method)).admin, true, path);
    refused(rest(path, method), /admin/i);
    allowed(rest(path, method), policy(true));
  }
  // Ids and unrelated words are never admin by substring.
  assert.equal(classify(rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE')).admin, false);
  assert.equal(classify(rest(`/api/v6/partstudios/d/${A}/w/${W}/e/${E}/features/featureid/Fowner1`, 'POST')).admin, false);
  allowed(rest(`/api/v6/elements/d/${A}/w/${W}/e/${E}`, 'DELETE'));
  // Admin on one document never covers another referenced one.
  refused(rest(`/api/v6/documents/${A}/share`, 'POST', {body: {documentId: B}}), /not authorized/, policy(true));
  const both = {docs: {[A]: {admin: true}, [B]: {admin: false}}};
  refused(rest(`/api/v6/documents/${A}/share`, 'POST', {query: {linkDocumentId: B}}), new RegExp(`admin.*${B}|${B}.*admin`, 'i'), both);
});

test('admin body fields need per-document admin; falsy values do not', () => {
  const doc = `/api/v6/documents/${A}`;
  for (const body of [{ownerId: 'x'}, {ownerType: 1}, {parentId: 'f'}, {projectId: 'p'}, {makePublic: true}, {isPublic: 'true'}, {isPublic: 1},
    {publicAccess: true}, {emailTo: ['x@y']}, {emailLink: true}, {anonymousAllowsExport: true}, {shareAction: 'x'}, {nested: [{EmailMessage: 'hi'}]}]) {
    assert.equal(classify(rest(doc, 'POST', {body})).admin, true, JSON.stringify(body));
    refused(rest(doc, 'POST', {body}), /admin/i);
    allowed(rest(doc, 'POST', {body}), policy(true));
  }
  for (const body of [{isPublic: false}, {makePublic: false}, {emailTo: []}, {emailLink: false}, {ownerType: 0}, {parentId: null}, {name: 'owner'}])
    assert.equal(classify(rest(doc, 'POST', {body})).admin, false, JSON.stringify(body));
  // GET queries carry no admin fields; createDocument with admin fields names no authorized document.
  assert.equal(classify(rest(doc, 'GET', {query: {ownerId: 'x'}})).admin, false);
  refused(rest('/api/v6/documents', 'POST', {body: {name: 'x', isPublic: true}}), /admin/i, policy(true));
  refused(rest('/api/v6/documents', 'POST', {body: {name: 'x', parentId: 'folder'}}), /admin/i, policy(true));
  allowed(rest('/api/v6/documents', 'POST', {body: {name: 'x', isPublic: false}}));
});

test('tabs are never refused and malformed policy fails closed', () => {
  // Default parameters would swallow `undefined`; call authorize directly.
  assert.doesNotThrow(() => authorize({kind: 'tabs'}, undefined));
  assert.throws(() => authorize(rest(`/api/v6/documents/${A}`), undefined), /not authorized/);
  for (const bad of [null, 'x', [], {docs: []}, {docs: {[A]: true}}, {docs: null}]) refused({kind: 'tabs'}, /policy/i, bad);
});

test('worker overwrites bridge-supplied trust fields from policy', () => {
  const job = {kind: 'state', target: {did: A, wid: W, eid: E}, admin_allowed: true, allow_untested_native: true};
  const trusted = applyPolicy(job, policy());
  assert.equal(trusted.admin_allowed, false); assert.equal(trusted.allow_untested_native, false);
  assert.equal(job.admin_allowed, true, 'input job is not mutated');
  const elevated = applyPolicy(job, policy(true, {allow_untested_native: true}));
  assert.equal(elevated.admin_allowed, true); assert.equal(elevated.allow_untested_native, true);
  assert.equal(applyPolicy({kind: 'tabs', admin_allowed: true}, policy(true)).admin_allowed, false);
  assert.throws(() => applyPolicy({...job, target: {did: B, wid: W, eid: E}}, policy(true)), /not authorized/);
});

test('effective policy merges worker-created documents under popup entries', () => {
  const created = {[C]: {admin: false, source: 'created', added: 2}};
  const merged = effectivePolicy(policy(), created);
  assert.deepEqual(Object.keys(merged.docs).sort(), [A, C]);
  allowed(rest(`/api/v6/documents/${C}`), merged);
  // The popup's entry (e.g. an admin toggle on a created document) wins.
  assert.equal(effectivePolicy({docs: {[C]: {admin: true}}}, created).docs[C].admin, true);
  assert.deepEqual(effectivePolicy(undefined, undefined).docs, {});
  for (const bad of [null, [], {[C]: true}]) assert.throws(() => effectivePolicy(policy(), bad), /policy/i);
});

test('created and copied documents are auto-authorized only after success from an authorized source', () => {
  const create = rest('/api/v10/documents', 'POST', {body: {name: 'New'}});
  const added = recordCreated(create, {status: 200, body: {id: C}}, policy(), {}, 5);
  assert.deepEqual(added, {[C]: {admin: false, source: 'created', added: 5}}, 'returns only the created map');
  const prior = {[B]: {admin: false, source: 'created', added: 1}};
  assert.deepEqual(Object.keys(recordCreated(create, {status: 200, body: {id: C}}, policy(), prior, 5)).sort(), [B, C]);
  const copy = rest(`/api/v6/documents/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'Copy'}});
  assert.deepEqual(recordCreated(copy, {status: 200, body: {newDocumentId: C}}, policy(), {}, 5)[C], {admin: false, source: 'created', added: 5});
  // A copy of a created document counts as authorized too.
  const fromB = rest(`/api/v6/documents/${B}/workspaces/${W}/copy`, 'POST');
  assert.equal(recordCreated(fromB, {status: 200, body: {newDocumentId: C}}, policy()), null);
  assert.ok(recordCreated(fromB, {status: 200, body: {newDocumentId: C}}, policy(), prior)[C]);
  assert.equal(recordCreated(create, {status: 403, body: {id: C}}, policy()), null);
  assert.equal(recordCreated(create, {error: 'failed'}, policy()), null);
  assert.equal(recordCreated(create, {status: 200, body: {id: 'not-hex'}}, policy()), null);
  assert.equal(recordCreated(rest('/api/v10/documents'), {status: 200, body: {id: C}}, policy()), null);
  assert.equal(recordCreated(rest(`/api/v6/documents/${A}/workspaces/${W}`, 'POST'), {status: 200, body: {id: C}}, policy()), null);
});

test('document names are bounded optional strings, labelled "name — id"', () => {
  assert.equal(docName(`  ${'x'.repeat(200)}  `), 'x'.repeat(120));
  assert.equal(docName('  Gearbox | Onshape '), 'Gearbox | Onshape');
  for (const bad of [undefined, null, 5, {}]) assert.equal(docName(bad), '');
  assert.equal(docLabel(A, {name: 'Gearbox'}), `Gearbox — ${A}`);
  assert.equal(docLabel(A, {}), A);
  // Optional name keeps old entries valid; a non-string name is malformed.
  assert.doesNotThrow(() => authorize(rest(`/api/v6/documents/${A}`), {docs: {[A]: {admin: false, name: 'Gearbox'}}}));
  refused({kind: 'tabs'}, /policy/i, {docs: {[A]: {admin: false, name: 5}}});
  assert.throws(() => effectivePolicy(policy(), {[C]: {name: ['x']}}), /policy/i);
  const copy = rest(`/api/v6/documents/${A}/workspaces/${W}/copy`, 'POST', {body: {newName: 'Copy'}});
  assert.deepEqual(recordCreated(copy, {status: 200, body: {newDocumentId: C, newDocumentName: ' Copy of X '}}, policy(), {}, 5)[C],
    {admin: false, source: 'created', added: 5, name: 'Copy of X'});
  const create = rest('/api/v10/documents', 'POST', {body: {name: 'New'}});
  assert.equal(recordCreated(create, {status: 200, body: {id: C, name: 'New'}}, policy(), {}, 5)[C].name, 'New');
});

test('tab URLs map to document ids', () => {
  assert.equal(didFromUrl(`https://cad.onshape.com/documents/${A}/w/${W}/e/${E}`), A);
  assert.equal(didFromUrl('https://cad.onshape.com/documents'), null);
  assert.equal(didFromUrl(`https://evil.example/documents/${A}/w/${W}`), null);
  assert.equal(didFromUrl(undefined), null);
});
