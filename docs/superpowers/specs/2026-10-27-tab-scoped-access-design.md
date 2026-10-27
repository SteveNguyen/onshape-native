# Tab-scoped access policy — design

Status: draft for review (2026-10-27). Builds on `security/document-scoping` (6900615).

## Intent

The user wants to let Claude work on one Part Studio of a large, shared company
document (Pollen, cad.onshape.com) without it being able to read or change
anything else: other tabs, other branches, versions, or the document itself.
Today authorization is per document: authorizing a document opens every tab,
every branch and version, and version/branch/merge operations. That is too
coarse for a real shared document.

Success: the user can, in a few clicks and with a plain summary they trust,
grant read or read+write on exactly one tab in one branch; widen it later with
one click when Claude asks; and keep version/branch/merge/tab/admin operations
off unless explicitly enabled.

## Goals

- Grants per **tab** (Onshape element: Part Studio, Assembly, Variable Studio,
  drawing, blob…) and per **branch** (workspace), with **Read** and **Write**
  separate. Write implies Read.
- **Document actions**, each a separate toggle, all off by default:
  create versions, create branches, merge/restore, create/delete/rename/move tabs
  (incl. tab folders), admin (existing admin category: share, permissions, public,
  delete document, move, transfer, webhooks/apps).
- **Access requests**: a refused call becomes a pending request the user can
  Allow/Deny with one click in the popup. Claude can never widen its own access.
- **Popup layout B** (chosen by the user): presets first, tree on demand.
- Default deny stays: anything not classifiable as an allowed (tab, branch, mode)
  or an enabled document action is refused.

## Non-goals

- Per-feature or per-part permissions inside a tab.
- Hosts other than cad.onshape.com (Enterprise subdomains).
- Restricting what Onshape itself evaluates server-side (a granted Part Studio
  deriving from another tab still regenerates; Claude just can't read that tab
  directly).
- Server-side enforcement: enforcement stays in the extension (the only trusted
  component between agent and Onshape session).

## Anti-goals (would be a failure even if it "works")

- Any path where agent-supplied data (job fields, model text, tab names) grants
  or widens access, or pre-selects "Allow".
- A summary line that says less than what is actually allowed.
- A grant on one branch silently applying to main or another branch.
- Popup so complex the user stops reading it and clicks "whole document".

## The popup (layout B)

Mockup: `.superpowers` companion screen `popup-layout.html`, option B.

```
Reachy arm · branch feature-gripper
Open tab: Gripper finger
[!] Claude asks to READ "Gripper body" (Part Studio) in feature-gripper  [Allow] [Deny]
(◉) This tab only — read + write Gripper finger
( ) This tab, read the rest of the document (this branch)
( ) Whole document in this branch
( ) Custom…
  ▸ Custom: choose tabs        (tree: folders > tabs, Read / Write checkboxes, open tab highlighted)
  ▸ Document actions (all off)  versions · branches · merge/restore · tabs · admin
Claude can read and edit Gripper finger in branch feature-gripper. Nothing else.
```

- Context comes from the active browser tab URL (`/documents/{did}/w/{wid}/e/{eid}`).
  The popup lists tabs and folders and the branch name by itself (user-initiated
  UI, not an agent job, so it is not policy-checked).
- Presets just set grants; picking Custom shows the current grants in the tree.
  A preset is shown as selected only if the grants exactly match it.
- On a version or microversion URL (`/v/`, `/m/`) the popup says grants apply to
  branches and offers none.
- The summary line is generated from the stored grants, not from the preset.
- Pending requests appear on top as banners, newest first; the extension icon
  badge shows their count.
- A list of all documents with any grant (with revoke) stays reachable, as today.

## Policy model

Stored by the popup in `chrome.storage.local` as `policy` (schema version 2):

```
policy = {
  version: 2,
  docs: {
    <did>: {
      name?,                         // display only
      branches: { <wid>: { name?, tabs: { <eid>: { mode: "read"|"write", name? } } } },
      actions: { versions, branches, merge, tabs, admin }   // booleans, default false
    }
  },
  allow_untested_native, allow_ui_fallback   // unchanged
}
```

- "Whole document in this branch" = a branch-wide wildcard (`tabs: "*"` with a
  mode) so tabs created later are included. (Builder may choose the encoding.)
- **Migration (my call):** v1 entries are dropped, not converted; the popup shows
  "Access model changed, re-authorize". Only test documents are affected and a
  silent conversion would grant more than the new UI suggests.
- **Created/copied documents (my call):** still auto-authorized, as whole
  document, all branches, read+write, actions versions/branches/tabs on,
  merge on, admin off (equivalent to today's behaviour). Stored in the
  worker-written `created` key, as now.

## Classification (policy.js)

Each job is reduced to a set of **needs**:

- `{did, wid, eid, mode}` — tab access in a branch.
- `{did, action}` — document action.
- `{did, overview}` — document-level read; satisfied by any tab grant on the document.

Rules:

- **REST paths** `…/d/{did}/w/{wid}/e/{eid}/…`: tab need; mode = read for GET,
  write otherwise. Paths with `/v/` or `/m/` instead of `/w/`: read of that tab
  (allowed if the tab is granted on any branch); never a write.
- **References inside a request** (query, JSON body, multipart text fields,
  native bodies): every element id found under element keys
  (`elementId`, `elementIds`, `elementIdSource`, …) together with its document
  (explicit `documentId` in the same object, else the request's document) is a
  **read** need on that tab. Workspace ids likewise must be a granted branch;
  version/microversion ids referencing another document's tab are read needs on
  that tab (any branch grant of it is enough — builder: confirm or refuse).
  The existing rule "every other 24-hex token is a document id and must be
  authorized" stays.
- **Document-level paths** (did but no element): classified by an explicit table
  into overview reads, document actions (versions, branches, merge/restore,
  tab create/delete/rename/move/copy) or admin. Anything not in the table is
  refused. Tab creation by Claude adds the new tab to the grant with write
  (it was enabled by the user via "tabs").
- **Native / display / state / open / ui jobs** carry `target {did, wid, eid}`:
  tab need on that target, mode from the command (native read list vs write;
  display, state, schema, open, ui_inspect = read; ui_action = write). The
  extension keeps its own copy of the native read list; it does not trust a
  job-supplied flag.
- **tabs job** (listing browser tabs): unchanged — url/title stripped for tabs
  showing a non-granted element (now per tab, not per document).
- Admin rules (segments, body fields, document delete) unchanged, now mapped to
  `actions.admin`.

## Access requests

- On refusal for a missing tab grant or document action, the worker writes a
  request to the worker-owned `requests` key: `{id, did, wid, eid?, mode|action,
  first_seen, count}`; deduplicated on the need; at most 20 kept; expire after
  1 hour (my call).
- The error returned to Claude says the request was filed and to ask the user to
  approve it in the popup, naming the tab by id and, if known, name.
- Names in banners come from Onshape listings fetched by the popup, never from
  the job. A request for a document with no grants at all shows the document id
  and asks the user to open it first (my call: no blind cross-document approvals).
- Allow writes exactly that grant into `policy`; Deny removes the request. No
  "allow all", no auto-approve.
- Admin and merge requests are not offered as one-click banners (my call): the
  user turns them on in Document actions deliberately.

## Bridge / server

- No new trust in the bridge. Error texts updated. `policy_v2` capability
  advertised; the bridge refuses jobs if only `policy_v1` is present.
- `resolve_target` / `document_tree` must keep working under a tab-only grant
  (document overview reads are allowed with any tab grant).
- Skill and docs: explain grants, requests, and that Claude must stop and ask
  when refused rather than look for another route.

## Testing

- Node unit tests (policy.test.mjs): per need type, allowed/denied matrix:
  granted tab read/write, other tab, other branch, version/microversion paths,
  references to other tabs in bodies (derived, assembly insert, copyelement),
  every document action on/off, unknown document-level path refused, admin,
  migration drop, created-doc grant, request dedupe/expiry/cap.
- Popup logic tests for preset detection and summary text from grants.
- Live (free account, test_claudeA, with a `go` from the user): grant only the
  Part Studio in one branch; verify Assembly 1 and another branch refused, a
  request appears, Allow lets the retry pass; version creation refused until
  toggled. Then, on user decision, the Pollen Part Studio.

## Decisions from the builder check (my calls)

- **Copies.** Copying a whole document or branch (`documents/{did}/workspaces/{wid}/copy`)
  reads every tab, so it needs Read on the whole branch ("Whole document in this
  branch" or wider); the resulting copy is then auto-authorized as today.
  `copyelement` needs Read on the source tab and Write (or tabs action) on the
  destination; it never authorizes anything new by itself.
- **Branches Claude creates** (with "branches" on) inherit exactly the source
  branch's grants (same tabs, same modes); nothing wider.
- **Read covers read-only POSTs** from an explicit list: FeatureScript evaluation,
  exports/translations not stored in the document, mass properties and similar
  query endpoints. A translation with `storeInDocument` is a tab creation.

## Decided by the user (2026-10-27)

1. **Tab and folder names are visible** with any tab grant on the document
   (document overview read: contents listing, current microversion, branch and
   version lists, names). Content of non-granted tabs stays blocked. No response
   filtering.
2. **History of granted tabs is readable**: `/v/` and `/m/` reads are allowed for
   a granted tab (any branch, any point in time). Writes only ever target `/w/` of
   a granted branch.
3. **Versioning is critical: the system must never break it.** Consequences
   (my calls, to be confirmed in review):
   - Create version and create branch: only with their toggle on; they are
     additive (nothing existing changes).
   - Merge and restore (the only versioning operations that overwrite work):
     toggle on **and** a one-shot approval in the popup for each operation,
     showing source and target branch/version; the approval is consumed by that
     one call. Never offered from an agent request banner.
   - Version/branch delete, version rename/metadata edits, and any
     versioning endpoint not explicitly listed: refused (admin at most).
   - Tests cover every versioning endpoint of the bundled REST catalog as
     refused by default.
4. Copies, new branches and read-only POSTs as described above: approved.

## Left to the builder

Storage encoding details, the document-level endpoint table (from the bundled
REST catalog), popup styling, request id format, exact error wording.
