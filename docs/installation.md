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

- **Authorized documents.** Nothing is authorized by default; the agent can only list tabs, and unauthorized tabs report only their id, window/active flags and document id (no title or URL). Open a document and press **Authorize this document** in the extension popup; **Revoke** removes it. Every command must name only authorized documents: the target `did` for native/state/display/UI commands plus every id in a native command body, and for REST the path, query and body as below.
- **Default-deny id scanning.** REST paths are decoded exactly once; paths containing `;`, `%25` (double encoding), `\`, `?`, `#`, `..` or control characters are refused. Every 24-hex token is treated as a document id that must be authorized: in path segments (except the id after `w`, `e`, `v`, `m`, `workspace(s)`, `version(s)`, `microversion(s)`, `translations`, `comments`, `featureid`, `nodeid`, `partid`, and the element id of `translatorFormats/<did>/<wv>/<wvid>/<eid>`), and anywhere inside every string value and object key of the query, the JSON body, multipart text fields and native bodies (comma lists, hrefs and `d<did>::v…` namespaces included). The only exemption is a value directly under a key in `SAFE_ID_KEYS` (`extension/policy.js`): element, workspace, version, microversion, feature, node, part, folder-group and property ids, whose meaning is always scoped by a document named elsewhere in the same request. Consequently user, team, company and folder ids are refused too.
- **Raw bodies.** A non-GET request with a raw (`body_base64`) body is refused unless its content type is `multipart/form-data`; its text fields (and JSON inside them) are scanned like a JSON body. File parts are not inspected.
- **Library documents.** Standard Content and other library/linked documents are documents too: inserting or deriving from one fails until you open it in a tab and authorize it.
- **Documents created or copied by the agent** (`POST /documents`, or copying a workspace of an already authorized document) are authorized automatically after a successful response, never with admin. The worker stores them separately (`created`) from your popup policy, so neither overwrites the other; **Revoke** removes both.
- **Requests naming no document** are refused, except: `GET users/sessioninfo` (signed-in user check), `POST documents` (create), `GET translations/<id>` (translation polling), `GET translations/translationformats`, `GET thumbnails/<content hash>` (thumbnailUri images), and the `comments` collection when its `did`/`documentId` query or body names an authorized document. Comment ids alone (`comments/<id>…`, including attachments) are refused.
- **Admin actions** need the per-document **Allow admin actions** checkbox, on every document involved. Admin means: any path segment among share/unshare, support sharing, ACL/permission(s), public access, publication(s), webhook(s), application(s), owner, transfer and move-to-folder; `DELETE` of a whole document; and any non-GET body, multipart field or query key (at any depth) named `owner*`, `public*`, `email*`, `anonymous*`, `share*`, `parentId`, `projectId`, `makePublic` or `isPublic` with a value other than false/0/""/null/empty list. (A comment reply's `parentId` therefore also needs admin.)
- **Advanced: allow untested native commands** (popup, global, off by default) unlocks native write commands that are in the captured client schema but not replay-verified.
- **Advanced: allow UI fallback clicks** (popup, global, off by default) is required for `ui_inspect`/`ui_action`, even on admin documents: the worker cannot see what a page control does. With it on, controls labelled share/public/permissions/invite/transfer/owner/webhooks/delete document still need per-document admin (a heuristic, not a guarantee).
- **Uploads.** `api_upload` reads only regular, non-hidden, singly linked files inside `<runtime>/uploads` (created with mode 0700; the error message prints its absolute path). Symlinks are resolved first and the final open refuses symlinks, so a link pointing outside is refused; hard-linked files are refused; bytes are read from the checked descriptor. Place files there yourself; do not let the agent pick arbitrary local paths.
- **Local pairing.** The bridge and extension share a random token in `<runtime>/bridge.json` (0600) and the generated `extension/local-config.js`. It never crosses a socket, so a process that grabs `127.0.0.1:8766` first learns nothing reusable:
  - WebSocket: the bridge sends a random challenge; the extension answers with its own nonce and `HMAC-SHA256(token, "ext\n" + server_nonce + "\n" + ext_nonce)`; the bridge replies `ready` with `HMAC-SHA256(token, "srv\n" + ext_nonce + "\n" + server_nonce)`. The extension closes the socket and runs no command until that proof checks out. Only `chrome-extension://` origins and one extension at a time are accepted.
  - HTTP: each request carries `Authorization: ONH <unix_ts>:<nonce>:<HMAC-SHA256(token, method\npath?query\nts\nnonce\nsha256_hex(body))>`. The bridge refuses timestamps more than 60 s off, replayed nonces, any other `Host` than `127.0.0.1:8766`, and any `Origin` header. Every authenticated response carries `X-ONH-MAC: HMAC-SHA256(token, "resp\n" + request_nonce + "\n" + sha256_hex(response_body))`; the MCP client, the startup probe and `scripts/request.py` (which signs for you) refuse responses without a valid one, so a squatter cannot feed fake results to the agent.
- **Exports** follow download redirects only to `cad.onshape.com`, `*.onshape.com` and S3 hostnames (virtual-hosted, path-style and regional), without cookies or bridge credentials.

Limits:

- The guarantees hold for an agent restricted to the MCP tools. An agent with filesystem or shell access can read the bridge token, or edit the unpacked extension (policy and all) and have it reloaded; do not grant such access alongside untrusted model text.
- A process squatting on `127.0.0.1:8766` cannot forge commands or results, but it does see request contents (paths, bodies, uploads) sent to it.
- Onshape session cookies stay in the browser; the authorized set limits which documents the agent touches, not what your Onshape account may do there.

## Troubleshooting

- **Missing client CLI:** put `codex` or `claude` on PATH, or choose `generic`.
- **Extension disconnected:** check the loaded extension, signed-in Onshape tab, and loopback port 8766. Browser and server must share the same host.
- **Disconnected right after an update:** bridge protocol 2 (signed requests, mutual WebSocket auth) does not talk to older extensions or servers. Reload the extension and restart the AI client.
- **Old tool behavior:** rerun the installer and restart the client; plugin installations contain separate source copies.
- **New extension location:** remove the old unpacked extension and load the printed directory.

The installer selects Windows/Linux/macOS paths automatically. Path handling is tested; full installation and browser integration on Windows and Linux still require live validation.
