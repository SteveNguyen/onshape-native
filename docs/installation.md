# Installation and updates

## Requirements

- A local AI client: Codex with the `codex` CLI, Claude Code with the `claude` CLI, or any client supporting stdio MCP.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) on PATH. It installs Python 3.12 and the locked dependencies automatically.
- A Chromium browser supporting unpacked Manifest V3 extensions, signed into `cad.onshape.com` on the same machine.

Client installation, account sign-in and browser extension approval are prerequisites/manual steps. The installer does not install AI clients or bypass browser approval. Use native Windows PowerShell with a Windows browser; WSL, containers, SSH and cloud-only clients are not automatically connected to the host browser.

## One setup command

```sh
uv run --python 3.12 https://raw.githubusercontent.com/godbrigero/onshape-native/main/install.py --client codex
```

Choose `--client claude`, `--client both`, or `--client generic` as appropriate. Run the command from any directory. For an already downloaded checkout or release ZIP, use:

```sh
uv run --python 3.12 install.py --client codex
```

Useful options:

| Option | Purpose |
|---|---|
| `--directory "PATH"` | Choose the downloaded source/extension location. Must be new or installer-managed. |
| `--runtime-dir "PATH"` | Choose the private pairing/artifact location. Keep it outside downloaded source. |
| `--source "PATH"` | Install from an existing checkout. |
| `--ref TAG_OR_COMMIT` | Select a GitHub source revision instead of `main`. |

The `main` URL above executes whatever is on that branch at the moment you run it, and installs that branch. Prefer a tag or commit SHA you have checked (for example on the GitHub commit page, or `git verify-commit`/`git verify-tag` in a clone), and pin both the raw script URL and `--ref` to it:

```sh
uv run --python 3.12 https://raw.githubusercontent.com/godbrigero/onshape-native/<SHA>/install.py --client codex --ref <SHA>
```

Review the script before executing if required by your environment.

Default application data locations are `~/Library/Application Support/OnshapeNative` on macOS, `$XDG_DATA_HOME/onshape-native` (or `~/.local/share/onshape-native`) on Linux, and `%LOCALAPPDATA%\OnshapeNative` on Windows. These are computed on the destination device. Paths in generated `.mcp.json` are intentionally absolute and private; they are not portable files to commit or share.

## Browser and client

1. Open the browser's extensions page (for example `chrome://extensions` or `edge://extensions`).
2. Enable Developer mode and load the **extension directory printed by the installer**.
3. Sign into Onshape in that browser profile.
4. Restart your AI client and check that `onshape_native` is available. In Claude Code, use `/mcp`.

The server starts its loopback HTTP companion automatically when the MCP client launches it. Pairing uses a device-generated secret; Onshape cookies stay in the browser. Do not run multiple separately paired bridges on port 8766.

For `generic`, merge the generated `.mcp.json` server entry into your client's stdio MCP configuration without replacing unrelated servers. Client configuration layouts vary, so this step is manual. The printed skill path contains optional agent instructions.

## Updates

Repeat the remote command with the same destination, or update your checkout and rerun its `install.py`. Installer-managed source is replaced; keep code edits in a separate checkout. Existing pairing is reused. Restart the AI client afterward. Reload the browser extension only when its files change. If you selected a custom runtime, keep using it; managed remote installs remember it.

Do not share `.mcp.json`, `.runtime`, virtual environments, `extension/local-config.js`, or installer marker files. To distribute a clean source ZIP, run `uv run python scripts/package.py`. A recipient configures fresh pairing on their own computer.

## Security model

The agent is treated as untrusted: model text (document names, tab titles, feature names) can prompt-inject it. The extension, not the server, decides what runs, from a policy only its popup and worker can write.

- **Tab grants.** Nothing is granted by default; the agent can only list browser tabs, and tabs showing a non-granted element report only their id, window/active flags and document id (no title or URL). Open a tab and pick a preset in the extension popup: *This tab only* (read + write), *This tab, read the rest of the branch*, *Whole document in this branch* (a `"*"` grant, so tabs created later are included) or *Custom* (tree of tabs with Read / Write checkboxes). Grants are per document, branch (workspace) and tab; write implies read. Writes only ever target `/w/` of a granted branch; `/v/` and `/m/` (history) are readable for a granted tab, never writable. Reads of a granted tab are branch-independent: a tab granted (read or write) in any branch can be read in every version and microversion (`/v/`, `/m/`), and referenced (inserted, derived, copied) from other tabs and documents. Grants apply to branches, so on a version/microversion page the popup offers none. A document with any tab grant also lets the agent read the document overview (document-level listings): tab and folder names, contents, branches and versions, document history, unit info, current microversion, merge preview, reference resolution and external-data downloads. Document history and merge preview reveal change summaries (edit descriptions, tab and feature names) of other tabs too. Overview routes refuse thumbnails (`withThumbnails` / `thumbnail*` query flags). The element metadata listing (per-tab properties) and insertables (parts, features and variables of every tab; REST and the native insertables query) are tab content: they need a whole-branch read on that `/w/` branch and are refused on `/v/`, `/m/` and `insertables/…/latest`; other tabs' content stays blocked. Display commands that persist (assembly visibility, motion preview preparation) need tab write; inspecting, capturing and camera/section/isolate views are reads. The popup's preset, tab tree and summary line are generated from the effective grants, including the tabs and branches Claude received for objects it created; unticking such a tab, or choosing a preset, also drops that received grant. A v1 (per-document) policy is treated as empty and the popup shows "Access model changed, re-authorize". **Revoke** removes a document's grants.
- **Document actions.** Per-document toggles, all off by default: *versions* (create version), *branches* (create branch), *tabs* (create/delete/rename/move/copy tabs), *merge* (enables merge/restore, see below) and *admin*. Every versioning endpoint not listed here (delete or rename version, etc.) is refused. A tab Claude creates needs a write grant on the branch it is created in and is then added to the grant with write; a branch Claude creates inherits the union of the document's tab grants on the source branches, nothing wider.
- **Merge and restore** need the *merge* toggle, whole-branch write on the target branch and a one-shot approval from the popup (valid 5 minutes) for that exact operation, showing the target, the merge source (branch name or version) or restore point, the default strategy and the number of per-tab overrides. The worker consumes the approval before running the job and it is single-use even if the job fails; a retry needs a new approval.
- **Access requests.** A refusal for a missing tab grant, branch grant or document action files a request (deduplicated per need, at most 20, expiring after 1 hour). The popup shows pending requests as banners (newest first; the icon badge shows the count) with **Allow** (writes exactly that grant) and **Deny**; there is no allow-all. Names come from Onshape listings fetched by the popup, never from the request. A request for a document with no grants asks you to open it first; only the versions, branches and tabs actions are approvable from a banner; branch-wide write and overview needs are not (grant a tab instead), and the merge and admin toggles are set deliberately in Document actions. The merge/restore banner offers 'Approve once' only while that document's Merge / restore action is on; otherwise it asks you to enable it in Document actions first.
- **Default-deny id scanning.** REST paths are decoded exactly once; paths containing `;`, `%25` (double encoding), `\`, `?`, `#`, `..` or control characters are refused. Every 24-hex token is treated as a document id that must be a document you granted: in path segments (except the id after `w`, `e`, `v`, `m`, `workspace(s)`, `version(s)`, `microversion(s)`, `translations`, `comments`, `featureid`, `nodeid`, `partid`, and the element id of `translatorFormats/<did>/<wv>/<wvid>/<eid>`), and anywhere inside every string value and object key of the query, the JSON body, multipart text fields and native bodies (comma lists, hrefs and `d<did>::v…` namespaces included). The only exemption is a value directly under a key in `SAFE_ID_KEYS` (`extension/policy.js`): element, workspace, version, microversion, feature, node, part, folder-group and property ids, whose meaning is always scoped by a document named elsewhere in the same request. Consequently user, team, company and folder ids are refused too. An element id (any `…elementId…` key or `e<id>` token) needs a read grant on that tab in every document key of its object: `documentId`/`documentIdSource`/`did` and every `<prefix>DocumentId` (an endpoint may pair a `documentId` with an element of `externalDocumentId`); an object naming no document falls back to the enclosing object's or request's document. Only a `<prefix>ElementId` whose own `<prefix>DocumentId` is present is checked against that document alone.
- **Raw bodies.** A non-GET request with a raw (`body_base64`) body is refused unless its content type is `multipart/form-data`; its text fields (and JSON inside them) are scanned like a JSON body. File parts are not inspected.
- **Library documents.** Standard Content and other library/linked documents are documents too: inserting or deriving from one fails until you open it in a tab and grant it.
- **Documents created or copied by the agent** (`POST /documents`, or copying a workspace of a document where the whole branch is readable) are off by default: both routes are refused until you enable *Advanced: allow creating new documents* in the popup (see below). Once enabled, they are granted automatically after a successful response: whole document, all branches, read + write, never admin. The worker stores them separately (`created`) from your popup policy, so neither overwrites the other; the `"*"` grant is kept until you **Revoke** the document in the popup's document list (which removes both).
- **Requests naming no document** are refused, except: `GET users/sessioninfo` (signed-in user check), `POST documents` (create, needs *Advanced: allow creating new documents*), `GET translations/<id>` (translation polling), `GET translations/translationformats`, and the `comments` collection: reading needs tab read on the `elementId`, writing needs tab write on it; comment calls without an `elementId` and comment ids alone (`comments/<id>…`, including attachments) are refused. Document thumbnails, content-hash thumbnails (`thumbnails/<hash>`, thumbnailUri images), `permissionset` and parts listings are refused.
- **Admin actions** need the per-document *admin* action toggle, on every document involved. Admin means: any path segment among share/unshare, support sharing, ACL/permission(s), public access, publication(s), webhook(s), application(s), owner, transfer and move-to-folder; `DELETE` of a whole document; and any non-GET body, multipart field or query key (at any depth) named `owner*`, `public*`, `email*`, `anonymous*`, `share*`, `parentId`, `projectId`, `makePublic` or `isPublic` with a value other than false/0/""/null/empty list. (A comment reply's `parentId` therefore also needs admin.)
- **Advanced: allow untested native commands** (popup, global, off by default) unlocks native write commands that are in the captured client schema but not replay-verified. Even then, untested commands whose names mention versions, workspaces, branches, release, revisions, merge, restore, publications, sharing, permissions, locks, comments or thumbnails, and every untested `ui.document.*` / `ui.collaboration.*` command, are refused (tab create/delete/rename/copy commands keep needing the *tabs* action).
- **Advanced: allow creating new documents** (popup, global, off by default) is required for `POST documents`, the workspace copy route (`documents/<did>/workspaces/<wid>/copy`, which still also needs a whole-branch read) and moving a tab into a new document (`moveelement` with `isNewDocument` set, which still also needs *admin*). Without it these calls are refused with a plain error (no access request is filed). With it on, the popup summary says: "Advanced: creating new documents is ON."
- **Advanced: allow UI fallback clicks** (popup, global, off by default) is required for `ui_inspect`/`ui_action`, even on admin documents: the worker cannot see what a page control does. With it on, controls labelled share/public/permissions/invite/transfer/owner/webhooks/delete document still need per-document admin (a heuristic, not a guarantee), and the popup summary says: "Advanced: UI fallback clicks are ON — clicks in an open document are not limited to granted tabs, branches or document actions."
- **Uploads.** `api_upload` reads only regular, non-hidden, singly linked files inside `<runtime>/uploads` (created with mode 0700; the error message prints its absolute path). Symlinks are resolved first and the final open refuses symlinks, so a link pointing outside is refused; hard-linked files are refused; bytes are read from the checked descriptor. Place files there yourself; do not let the agent pick arbitrary local paths.
- **Local pairing.** The bridge and extension share a random token in `<runtime>/bridge.json` (0600) and the generated `extension/local-config.js`. It never crosses a socket, so a process that grabs `127.0.0.1:8766` first learns nothing reusable:
  - WebSocket: the bridge sends a random challenge; the extension answers with its own nonce and `HMAC-SHA256(token, "ext\n" + server_nonce + "\n" + ext_nonce)`; the bridge replies `ready` with `HMAC-SHA256(token, "srv\n" + ext_nonce + "\n" + server_nonce)`. The extension closes the socket and runs no command until that proof checks out. Only `chrome-extension://` origins and one extension at a time are accepted.
  - HTTP: each request carries `Authorization: ONH <unix_ts>:<nonce>:<HMAC-SHA256(token, method\npath?query\nts\nnonce\nsha256_hex(body))>`. The bridge refuses timestamps more than 60 s off, replayed nonces, any other `Host` than `127.0.0.1:8766`, and any `Origin` header. Every authenticated response carries `X-ONH-MAC: HMAC-SHA256(token, "resp\n" + request_nonce + "\n" + sha256_hex(response_body))`; the MCP client, the startup probe and `scripts/request.py` (which signs for you) refuse responses without a valid one, so a squatter cannot feed fake results to the agent.
- **Exports** follow download redirects only to `cad.onshape.com`, `*.onshape.com` and S3 hostnames (virtual-hosted, path-style and regional), without cookies or bridge credentials.

Limits:

- The guarantees hold for an agent restricted to the MCP tools. An agent with filesystem or shell access can read the bridge token, or edit the unpacked extension (policy and all) and have it reloaded; do not grant such access alongside untrusted model text.
- A process squatting on `127.0.0.1:8766` cannot forge commands or results, but it does see request contents (paths, bodies, uploads) sent to it.
- Onshape session cookies stay in the browser; the grants limit which tabs the agent touches, not what your Onshape account may do there.

## Troubleshooting

- **Missing client CLI:** put `codex` or `claude` on PATH, or choose `generic`.
- **Extension disconnected:** check the loaded extension, signed-in Onshape tab, and loopback port 8766. Browser and server must share the same host.
- **Disconnected right after an update:** bridge protocol 2 (signed requests, mutual WebSocket auth) does not talk to older extensions or servers. Reload the extension and restart the AI client.
- **Old tool behavior:** rerun the installer and restart the client; plugin installations contain separate source copies.
- **New extension location:** remove the old unpacked extension and load the printed directory.

The installer selects Windows/Linux/macOS paths automatically. Path handling is tested; full installation and browser integration on Windows and Linux still require live validation.
