# Tab-scoped access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-document authorization in the extension with per-tab, per-branch Read/Write grants, separate document-action toggles (versioning critical), access requests the user approves in a new presets-first popup.

**Architecture:** Enforcement stays in the extension worker. `policy.js` reduces each job to a list of *needs*; a new `grants.js` owns the v2 policy data model, lookups and the pure popup model (presets, summary); a new `requests.js` owns access requests and one-shot approvals. The popup becomes layout B. The bridge only checks a `policy_v2` capability.

**Tech Stack:** Chrome MV3 extension (ES modules, no build), `node --test` for JS, pytest for Python.

**Spec:** `docs/superpowers/specs/2026-10-27-tab-scoped-access-design.md`

## Global Constraints

- Host: `https://cad.onshape.com` only.
- Default deny: a job whose needs are not all satisfied is refused; a REST path not matched by a classification rule is refused.
- Claude never widens access: only `popup.js` writes `policy` and `approvals`; the worker writes only `created`, `requests`, `consumed`.
- Write implies Read. Writes only on `/w/` of a granted branch; `/v/` and `/m/` are read-only.
- Versioning: create version/branch need their toggle; merge/restore need toggle **and** a one-shot popup approval **and** whole-branch write on the target branch; every other versioning endpoint is refused.
- v1 policies (no `version: 2`) are treated as empty; the popup shows "Access model changed, re-authorize".
- Requests: deduplicated per need, max 20, expire after 1 hour.
- Names (tabs, branches, documents) are display-only, bounded with `docName`, rendered with `textContent`, never grant access.
- Manifest version `0.6.0`; worker advertises `policy_v2` (and no longer `policy_v1`).
- Work on a new local branch `security/tab-scoping` from `security/document-scoping`. **Do not commit or push unless the user asks**; the "Checkpoint" steps below only run the suite.
- Bash conformance (user rule): no `cd`, redirections, heredocs or pipes; absolute paths. JS tests: `node --test /home/steve/Project/Repo/divers/onshape-native/tests/`; Python: `uv run --project /home/steve/Project/Repo/divers/onshape-native pytest -q /home/steve/Project/Repo/divers/onshape-native/tests`.

## Review Focus

1. A tab id reaching Onshape outside a recognised position (query string, body key not in the element-key list, namespace string) must still be either authorized or refused — never ignored. → Task 2 test `element ids hidden in bodies are needs`.
2. A grant on branch W must not satisfy a write on branch W2 of the same tab, even when W2 is reached through a version-to-workspace link. → Task 3 test `branch isolation`.
3. A copied document or a branch created by Claude must not end up with more than the user granted. → Task 4 tests `workspace copy needs whole-branch read`, `new branch inherits only granted tabs`.
4. A stale or replayed merge/restore approval must not authorize a second merge, or a merge with a different body. → Task 5 test `one-shot approval is bound to the exact job and consumed`.
5. A popup preset shown as selected must exactly match the stored grants; the summary must never under-state access. → Task 7 tests `presetOf is exact`, `summary lists every grant and action`.

---

### Task 1: v2 policy data model (`grants.js`)

**Files:**
- Create: `extension/grants.js`
- Modify: `extension/policy.js` (remove `checkPolicy`, `effectivePolicy`, `entryOk`, re-export from grants)
- Test: `tests/grants.test.mjs`

**Interfaces:**
- Produces (all pure, no chrome APIs):
  - `ACTIONS = ["versions", "branches", "merge", "tabs", "admin"]`
  - `checkPolicy(policy) -> Policy`: `undefined` → empty v2 policy; object without `version: 2` → empty v2 policy with `stale: true`; malformed v2 → throws `/malformed.*popup/`.
  - `effectivePolicy(policy, created) -> Policy`: merges worker-written `created = {docs: {did: DocEntry}, grants: {did: {branches: {...}}}}` into the popup policy. Popup doc entries win for `actions`; branch/tab grants are unioned (max mode). Old flat v1 `created` maps are ignored.
  - `tabMode(policy, did, wid, eid) -> "write"|"read"|null`: max of `branches[wid].tabs[eid].mode`, `branches[wid].all`, `branches["*"].all`.
  - `anyBranchMode(policy, did, eid) -> mode|null`: max over all branches (history and references).
  - `branchMode(policy, did, wid) -> mode|null`: `branches[wid].all` or `branches["*"].all`.
  - `hasAnyGrant(policy, did) -> boolean`; `actionOn(policy, did, action) -> boolean`.
- Policy shape (spec "Policy model"):
  ```
  {version: 2, allow_untested_native, allow_ui_fallback,
   docs: {did: {name?, added, source: "user"|"created",
                actions: {versions, branches, merge, tabs, admin},
                branches: {wid|"*": {name?, all?: "read"|"write",
                                      tabs: {eid: {mode: "read"|"write", name?}}}}}}}
  ```
  `"*"` (all branches) is only ever set by `created` documents.

- [ ] **Step 1: Write failing tests** in `tests/grants.test.mjs`: `checkPolicy` (undefined, v1 object → `stale: true` and no docs, malformed branch/tab/mode → throws); `tabMode` (tab grant, `all` grant, `"*"`, other branch → null, other tab → null, write beats read); `anyBranchMode`; `effectivePolicy` (created doc added; created grant on a popup doc adds a tab without changing its `actions`; v1 flat `created` ignored).
- [ ] **Step 2: Run** `node --test /home/steve/Project/Repo/divers/onshape-native/tests/grants.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement `extension/grants.js`** with the signatures above; ids lower-cased; validation rejects any mode other than `"read"`/`"write"`, non-hex keys (except `"*"`), non-boolean actions.
- [ ] **Step 4: Run** the same command → PASS.

### Task 2: Classification into needs (`policy.js`)

**Files:**
- Modify: `extension/policy.js`
- Test: `tests/policy.test.mjs` (rewrite helpers, keep every existing security case)

**Interfaces:**
- Produces: `classify(job) -> {needs: Need[], admin: boolean, reason?: string, critical?: "merge"|"restore"}` where
  ```
  Need = {did, type: "tab",      wid: hex|null /* null = any branch */, eid, mode}
       | {did, type: "branch",   wid, mode}            // whole branch
       | {did, type: "overview"}
       | {did, type: "action",   action}               // one of ACTIONS
  ```
- `targetFromUrl(url) -> {did, wvm, wvmid, eid|null}|null` (cad.onshape.com only); `didFromUrl` kept.

Rules (from the spec "Classification", plus the catalog scan of `data/openapi.json`):

- REST element paths `…/d/{did}/{w|v|m}/{id}/e/{eid}…`: GET → `tab` read; `/w/` + non-GET → `tab` write on `wid`; `/v/`,`/m/` → `tab` read with `wid: null`, and non-GET there is refused unless in `READ_POSTS`.
- `READ_POSTS` (non-GET that count as read, `wid: null` if not `/w/`): `featurescript`, `idtranslations`, `export`, `export/(gltf|obj|step)`, `translations` (only when body `storeInDocument` is not true; otherwise `action tabs` + tab write), `content/jsonpaths`, `elements/d/{did}/e/{eid}/configurationencodings`.
- `DELETE elements/d/{did}/w/{wid}/e/{eid}` → `action tabs` + tab write. `bomelement` POST → `action tabs` + tab read.
- Document-level routes, explicit table `DOC_ROUTES` (method + regex on the version-stripped path) → needs; anything else with a did and no `/e/` is refused (`/not classified/`):
  - overview: GET `documents/{did}`, `documents/d/{did}/{wvm}/{id}/(contents|elements|unitinfo|currentmicroversion|insertables|documenthistory)`, `documents/d/{did}/versions(/{vid})?`, `documents/d/{did}/workspaces`, `documents/{did}/w/{wid}/mergepreview`, `appelements/d/{did}/{wvm}/{id}/resolvereferences`, `metadata/d/{did}/{wvm}/{id}/e`, `insertables/d/{did}/latest`, `documents/d/{did}/externaldata/{fid}`.
  - `action versions`: POST `documents/d/{did}/versions`.
  - `action branches`: POST `documents/d/{did}/workspaces`.
  - `action merge` + `branch write` on target + `critical`: POST `documents/{did}/workspaces/{wid}/merge` (critical `"merge"`), POST `documents/{did}/w/{wid}/restore/{v|m}/{id}` (critical `"restore"`).
  - `action tabs` + `branch`-level nothing: POST `(partstudios|assemblies|featurestudios|blobelements)/d/{did}/w/{wid}`, `variables/d/{did}/w/{wid}/variablestudio`, `drawings/d/{did}/w/{wid}/create`, `translations/d/{did}/w/{wid}`.
  - `elements/copyelement/{did}/workspace/{wid}` POST: `action tabs` on destination + `tab` read (`wid: null`) on body `documentIdSource`/`elementIdSource`.
  - `documents/{did}/workspaces/{wid}/copy` POST: `branch read` on `wid` (no action; result auto-authorized in Task 4).
  - admin: existing `ADMIN_SEGMENTS`/`ADMIN_FIELD`/document DELETE, plus POST `documents/{did}` (attributes), POST `documents/{did}/notes`, POST `documents/d/{did}/w/{wid}/moveelement` → `action admin`.
  - Explicitly refused (test each): DELETE `documents/d/{did}/workspaces/{wid}`, POST `metadata/d/{did}/{wv}/{id}` (version/workspace metadata), POST `documents/d/{did}/w/{wid}/revertunchangedtorevisions`, POST `documents/d/{did}/w/{wid}/syncAppElements`, `appelements/d/{did}/w/{wid}(/bulkcreate|/transactions)?` POST.
- References in query/JSON body/multipart fields/native bodies: an object holding an element key (`elementid`, `elementids`, `elementidsource`) yields `tab` read, `wid: null`, on `(documentId ?? documentIdSource ?? request did, eid)`; namespace strings `d{did}::…::e{eid}` likewise. `workspaceid` in a reference object to another tab yields nothing extra (any-branch read already covers history). Every other 24-hex token is still treated as a document id (`overview` need is not enough: it must be a document with any grant **and** — if it sits in an element-key object — the tab need above).
- Targeted kinds (`native`, `state`, `schema`, `open`, `display`, `ui_inspect`, `ui_action`): `tab` on `target` with mode read for `state`, `schema`, `open`, `display`, `ui_inspect`, native commands in `NATIVE_READS`; write otherwise. `NATIVE_READS` is a copy of `READS` in `onshape_native/native_catalog.py` (a Python test asserts they match, Task 6). `NATIVE_TABS = {ui.document.GBTUiEditElementGroups, GBTUiDeleteElements, GBTUiCopyElements, GBTUiRenameElement, GBTUiInsertElement}` add `action tabs`. `ui.document.GBTUiUpgradeWorkspaceCall` and `ui.GBTUiWorkspaceRenamed` are refused.
- `tabs` kind → `[]`.

- [ ] **Step 1: Rewrite test helpers** in `tests/policy.test.mjs`: `policy(admin)` now builds a v2 document grant `{branches: {"*": {all: "write", tabs: {}}}, actions: {admin, versions:false, …}}` so every existing security case keeps its meaning; run once → existing cases FAIL (old API).
- [ ] **Step 2: Add failing classification tests**: `element paths map to tab needs` (GET/POST on `/w/`, `/v/`, `/m/`), `read-only POSTs are reads` (each `READ_POSTS` route; translation with `storeInDocument: true` → tabs action), `document routes are classified` (one assertion per `DOC_ROUTES` row), `unlisted document routes are refused` (a made-up `POST documents/d/{A}/w/{W}/frobnicate`), `element ids hidden in bodies are needs` (assembly `createInstance` body `{documentId: A, elementId: E2}`, derived feature `namespace`, `copyelement` source, native insert), `native commands map to modes` (one READS command → read, one write → write, `GBTUiEditElementGroups` → tabs action, `GBTUiUpgradeWorkspaceCall` → refused).
- [ ] **Step 3: Implement** in `extension/policy.js`; keep `segments`, `ids`, `walk`, `formFields`, canonical-path checks unchanged.
- [ ] **Step 4: Run** `node --test /home/steve/Project/Repo/divers/onshape-native/tests/policy.test.mjs` → PASS.

### Task 3: Authorization against grants

**Files:**
- Modify: `extension/policy.js`
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 lookups, Task 2 `classify`.
- Produces:
  - `class AccessError extends Error { need }` (thrown for an unmet tab/branch/action need; `need` is the first unmet `Need`).
  - `authorize(job, policy, approvals = {}, consumed = []) -> {needs, approvalKey?}`: every need satisfied (`tab` → `tabMode`/`anyBranchMode` ≥ mode; `branch` → `branchMode` ≥ mode; `overview` → `hasAnyGrant`; `action` → `actionOn`); admin as before but via `actionOn(did, "admin")`; for `critical`, also requires `approvals[jobKey(job)] > now` and key not in `consumed`, else `AccessError` with need `{did, type: "approval", critical, key}`.
  - `applyPolicy(job, policy, approvals, consumed) -> job` with `admin_allowed`, `allow_untested_native` as today.
  - `jobKey(job) -> string`: stable JSON (sorted keys) of `{method, path, query, body}`.
- Error texts: tab → `No ${mode} access to tab ${eid} in branch ${wid} of document ${did}. An access request was filed: ask the user to approve it in the Onshape Native popup.`; action → `Document action "${action}" is off for ${did}. Ask the user to enable it in the popup (Document actions).` (no request filed for `admin`/`merge`, see Task 5).

- [ ] **Step 1: Failing tests**: `tab grant read vs write`, `branch isolation` (write grant on W; write via W2 refused; `/v/` read of the same tab allowed; `/w/W2` GET refused), `history reads need a grant on any branch`, `overview needs any grant`, `each action toggle` (versions, branches, tabs on/off), `merge needs toggle, whole-branch write and approval`, `catalog versioning endpoints refused by default` (reads `data/openapi.json`; every non-GET operation whose path contains `versions`, `workspaces`, `merge`, `restore` or `revert`, ids substituted, is refused under a whole-branch write grant with all actions off), `admin unchanged`, `UI fallback and untested native toggles unchanged`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `node --test /home/steve/Project/Repo/divers/onshape-native/tests/policy.test.mjs` → PASS.

### Task 4: Auto-grants after create/copy/branch/tab creation

**Files:**
- Modify: `extension/policy.js` (`recordCreated`)
- Test: `tests/policy.test.mjs`

**Interfaces:**
- `recordCreated(job, result, policy, created, now) -> created|null` (same signature, v2 `created` shape from Task 1):
  - POST `documents` or authorized `workspaces/{wid}/copy` → `created.docs[newId] = {source: "created", added: now, name?, branches: {"*": {all: "write", tabs: {}}}, actions: {versions: true, branches: true, tabs: true, merge: true, admin: false}}`.
  - POST `documents/d/{did}/workspaces` (2xx, body `id`) → `created.grants[did].branches[newWid] = ` union of the document's tab grants and `all` across its granted branches (max mode). **My call, deviation to confirm with the user:** Onshape branches from a version, not from a branch, so "source branch" is not known; the union never exceeds what the user granted in that document.
  - Tab creation routes of Task 2 (2xx, body `id`) and `copyelement` (body `newElementId`/`id`) → `created.grants[did].branches[wid].tabs[newEid] = {mode: "write"}`.
- [ ] **Step 1: Failing tests**: `create document authorizes it fully except admin`, `workspace copy needs whole-branch read` (tab-only grant → refused by `authorize`; whole-branch read → allowed and recorded), `new branch inherits only granted tabs`, `created tab gets write`, `failed responses record nothing`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

### Task 5: Access requests and one-shot approvals (`requests.js`)

**Files:**
- Create: `extension/requests.js`
- Test: `tests/requests.test.mjs`

**Interfaces:**
- `fileRequest(requests, need, now, describe?) -> requests`: key = stable JSON of `need`; existing key → `count + 1`, `last_seen = now`; new → `{id: key, need, first_seen: now, last_seen: now, count: 1, ...describe}`; drops entries with `last_seen < now - 3_600_000`; keeps the 20 most recent. Needs of type `action` with `admin` or `merge` are never filed (returns input unchanged). Approval needs are filed with `describe = {method, path_summary}` (ids only, no body).
- `liveRequests(requests, now) -> Request[]` newest first.
- `approve(policy, request, ctxNames) -> policy` (used by popup): tab need → `setTab`-equivalent grant (`wid: null` needs are approved on the branch the user is viewing; if the popup is not on that document, returns policy unchanged and the popup shows "open this document first"); action need → toggle on (`versions`, `branches`, `tabs` only).
- `approveOnce(approvals, key, now) -> approvals` (`expires = now + 300_000`); `pruneApprovals(approvals, consumed, now)`.
- [ ] **Step 1: Failing tests**: `dedupe`, `cap 20`, `expiry 1h`, `admin and merge actions are not filed`, `approve grants exactly the need`, `approve refuses when the popup context is another document`, `one-shot approval is bound to the exact job and consumed` (with Task 3 `authorize`: approved key passes once; same key in `consumed` refused; different body refused; expired refused).
- [ ] **Step 2: Run** `node --test /home/steve/Project/Repo/divers/onshape-native/tests/requests.test.mjs` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

### Task 6: Worker, tab context and bridge wiring

**Files:**
- Modify: `extension/worker.js`, `extension/tab-context.js`, `extension/manifest.json` (version `0.6.0`), `onshape_native/bridge.py:128`
- Test: `tests/tab-context.test.mjs`, `tests/test_bridge.py`, new `tests/test_native_reads_sync.py`

**Interfaces:**
- Worker: `stored()` reads `policy`, `created`, `requests`, `approvals`, `consumed`; `execute` calls `applyPolicy(job, effectivePolicy(policy, created), approvals, consumed)`; on `AccessError` writes `fileRequest(...)` to `requests`, sets badge text to the live request count (e.g. `"1"`, orange `#d97706`), rethrows; after a successful critical job appends its key to `consumed` (cap 50). Capability list: `policy_v2` replaces `policy_v1`. Badge restores `"ON"` when no live requests.
- `tabContext(browser, policy)`: a tab is `authorized` iff `targetFromUrl` gives an element with `tabMode(policy, did, wvmid, eid)` (for `/w/`) or `anyBranchMode` (for `/v/`,`/m/`); document-only URLs → `hasAnyGrant`.
- Bridge: refuse non-`tabs` jobs when `"policy_v2"` is not advertised: `"Extension policy is outdated; reload the Onshape Native extension (needs policy_v2)."`
- [ ] **Step 1: Failing tests**: tab-context `other tab of an authorized document is stripped`, `granted tab keeps title and url`; `test_bridge.py` `policy_v1 only extension is refused`; `test_native_reads_sync.py` parses `NATIVE_READS` from `extension/policy.js` and asserts equality with `native_catalog.READS`.
- [ ] **Step 2: Run** JS and Python suites → FAIL. **Step 3: Implement.** **Step 4: Run** both suites → PASS.

### Task 7: Popup model (pure) — presets and summary

**Files:**
- Modify: `extension/grants.js`
- Test: `tests/grants.test.mjs`

**Interfaces:**
- `ctx = {did, wid, eid, docName, branchName, tabs: [{eid, name, type, folder?}]}` (built by the popup from Onshape listings).
- `PRESETS = ["tab", "tab_read_rest", "branch"]`: `tab` → `branches[wid] = {tabs: {eid: write}}`; `tab_read_rest` → `{all: "read", tabs: {eid: write}}`; `branch` → `{all: "write", tabs: {}}`. Applying a preset replaces only `branches[wid]` of that document; `actions` untouched.
- `applyPreset(policy, ctx, preset) -> policy`; `setTab(policy, ctx, eid, mode|null) -> policy`; `setAction(policy, did, action, on) -> policy`; `revokeDocument(policy, did) -> policy`.
- `presetOf(policy, ctx) -> "tab"|"tab_read_rest"|"branch"|"custom"|"none"` — exact match of `branches[wid]` only.
- `summary(policy, ctx) -> string`, e.g. `Claude can read and edit Gripper finger in branch feature-gripper. Nothing else.`; lists every granted tab of this branch by name (unknown → id), notes `"Read: the rest of this branch"`, grants on other branches (`"+ 2 other branches"`), every enabled action, and admin in a separate sentence `"Admin actions are ON."`.
- [ ] **Step 1: Failing tests**: `presetOf is exact` (preset → same name; extra tab → custom; other branch's grants ignored), `applyPreset leaves other branches and actions`, `summary lists every grant and action` (tab only, read rest, branch, + versions on, + admin on, + other branch).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

### Task 8: Popup UI (layout B)

**Files:**
- Modify: `extension/popup.html`, `extension/popup.js`
- Test: manual in the browser (with the user's go) — logic is covered by Task 7.

**Interfaces:**
- Consumes: Task 7 model, Task 5 `liveRequests`/`approve`/`approveOnce`, Task 1 `checkPolicy`.
- Context: `targetFromUrl(activeTab.url)`; listings via `fetch` (credentials included) of `GET /api/v10/documents/d/{did}/w/{wid}/contents` (tabs and folders) and `GET /api/v10/documents/d/{did}/workspaces` (branch name). These are user-initiated popup reads, not agent jobs.
- Layout (top to bottom, width 360px): connection row; stale-policy notice; request banners (`Claude asks to READ "Gripper body" (Part Studio) in feature-gripper [Allow] [Deny]`; approval banners for merge/restore show method, branch/version ids and `[Approve once]`, only when the merge toggle is on); document + branch + open tab; preset radios (Task 7 `PRESETS` + Custom); `<details>` Custom tree (folders → tabs, Read/Write checkboxes, open tab highlighted, Write ticks Read); `<details>` Document actions with the five toggles and the spec's warnings; summary line (`summary()`); `<details>` All authorized documents (revoke); Advanced toggles (unchanged). On `/v/` or `/m/` URLs: "Grants apply to branches; open a branch to grant access."
- [ ] **Step 1: Implement** HTML/JS; all model text via `textContent`.
- [ ] **Step 2: Run** the full JS suite → PASS (no regressions).
- [ ] **Step 3: Ask the user** for a go to reload the extension and review the popup on test_claudeA; fix what they report.

### Task 9: Docs and skill

**Files:**
- Modify: `docs/installation.md` (security model section), `skills/onshape-native-modeling/SKILL.md`, `README.md` (security bullet), `docs/superpowers/specs/2026-10-27-tab-scoped-access-design.md` (record the Task 4 branch-inheritance deviation once the user confirms)
- [ ] **Step 1:** Document grants, presets, requests, document actions and the merge/restore one-shot approval; in the skill: when refused, stop, tell the user what was requested and why, wait for approval, never seek another route; never ask for merge/restore unless the user asked for it.
- [ ] **Step 2: Checkpoint** — full JS + Python suites PASS.

### Task 10: Live validation (needs the user's explicit go)

**Files:**
- Create: `docs/evidence/tab-scope-validation.json`

- [ ] **Step 1:** On test_claudeA (`978625c5cbcf7259225315cb`, w `cdc846fb3a6cf924c62b4632`): preset "This tab only" on Part Studio `28aaef7058b273ff7766858f`. Verify: Part Studio read + feature edit OK; Assembly 1 `4451388a774fd494f7eee7c2` refused and a request banner appears; Allow → retry passes; `document_tree` lists names; create version refused until toggled, then allowed; merge refused without approval; share refused.
- [ ] **Step 2:** Create a second branch via the Onshape UI (user), verify the Part Studio grant does not apply there.
- [ ] **Step 3:** Record results in the evidence file; revert test edits; report. Pollen Part Studio only after a separate go.
