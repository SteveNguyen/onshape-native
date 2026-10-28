"""Authenticated loopback HTTP -> extension WebSocket broker; no write retries."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import re
import secrets
import socket
import time
import base64
from urllib.parse import unquote, urlsplit, parse_qs

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from .config import load_config, mac, request_message, response_mac, response_valid, sign_request
from .native_catalog import is_allowed, READS

MAX_BODY = 96 * 1024 * 1024
PROTOCOL = 2
REPLAY_WINDOW = 60  # seconds of clock skew accepted on signed requests
MAX_NONCES = 10_000  # unexpired nonces remembered; bounds replay-cache memory
NONCE = re.compile(r"[0-9a-f]{32}")
MAC = re.compile(r"[0-9a-f]{64}")
# Onshape's export bucket hostname has not been captured live yet (tests only use
# sample.s3.amazonaws.com); pin it once observed. Virtual-hosted, path-style and regional S3.
S3_HOST = re.compile(r"(?:[a-z0-9.-]+\.)?s3([.-][a-z0-9-]+)?\.amazonaws\.com")
# Same canonical-path rule as extension/policy.js: decode once and refuse anything
# a server or fetch() could read differently (double encoding, matrix params, control chars).
NON_CANONICAL = re.compile(r"[;\\?#\x00-\x1f]|\.\.")


class BridgeError(Exception):
    pass


def validate_job(job):
    if not isinstance(job, dict):
        raise BridgeError("Expected a JSON object.")
    kind = job.get("kind")
    if not isinstance(kind, str) or kind not in {"rest", "native", "state", "schema", "tabs", "open", "ui_inspect", "ui_action", "display"}:
        raise BridgeError("Unknown command kind.")
    if kind == "rest":
        path = job.get("path", "")
        if not isinstance(path, str):
            raise BridgeError("API path must be a string.")
        try:  # malformed escapes and invalid UTF-8 are refused, as decodeURIComponent does
            decoded = None if re.search(r"%25|%(?![0-9a-f]{2})", path, re.I) else unquote(path, errors="strict")
        except UnicodeDecodeError:
            decoded = None
        if not re.match(r"^/api/(?:v\d+/)?[a-zA-Z]", path) or decoded is None or NON_CANONICAL.search(decoded):
            raise BridgeError("Expected a canonical Onshape /api/ path, without query, traversal, ';', '\\', control characters or double encoding.")
        if job.get("method") not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise BridgeError("Unsupported HTTP method.")
        if re.search(r"/(?:clientinfo|oauth|apikeys)(?:/|$)", decoded, re.I) or (re.search(r"/users/session/?$", decoded) and job["method"] != "GET"):
            raise BridgeError("Authentication endpoints are not exposed.")
        if "headers" in job:
            raise BridgeError("Caller-supplied headers are not accepted.")
        for field in ("content_type", "accept"):
            if field in job and (not isinstance(job[field], str) or any(c in job[field] for c in "\r\n")):
                raise BridgeError("Invalid media type.")
        headers = job.get("request_headers", {})
        if not isinstance(headers, dict) or any(k.lower() not in {"if-none-match", "range"} or not isinstance(v, str) or "\r" in v or "\n" in v for k,v in headers.items()):
            raise BridgeError("Only If-None-Match and Range request headers are accepted.")
        if not isinstance(job.get("query", {}), dict):
            raise BridgeError("Query must be an object.")
    if kind in {"native", "state", "schema", "open", "ui_inspect", "ui_action", "display"}:
        target = job.get("target", {})
        if not isinstance(target, dict) or set(target) != {"did", "wid", "eid"} or any(not isinstance(x, str) or not re.fullmatch(r"[a-f0-9]{24}", x) for x in target.values()):
            raise BridgeError("Native commands require exact did, wid, eid target IDs.")
    if kind == "display":
        from .display import validate_display_job
        try:
            validate_display_job(job)
        except ValueError as error:
            raise BridgeError(str(error)) from None
        if type(job.get("tab_id")) is not int or job["tab_id"] < 0:
            raise BridgeError("Display commands require an exact tab_id.")
        args = job.get("args", {})
        writes = job["operation"] == "visibility" or (job["operation"] == "camera" and args.get("action") != "read") or (job["operation"] == "motion" and args.get("action") == "prepare")
        if writes and not re.fullmatch(r"[a-f0-9]{24}", str(job.get("expected_microversion", ""))):
            raise BridgeError("Display writes require expected_microversion from fresh state.")
    if kind == "ui_action":
        if not isinstance(job.get("backend_unavailable_reason"), str) or len(job["backend_unavailable_reason"].strip()) < 10:
            raise BridgeError("Explain why a backend command cannot perform this action.")
        if job.get("action") not in {"click", "double_click", "context_menu", "fill", "select"}:
            raise BridgeError("Unsupported UI action.")
        if not isinstance(job.get("control"), int) or not 0 <= job["control"] < 500 or not job.get("snapshot"):
            raise BridgeError("Use a control and snapshot from ui_inspect.")
        if not re.fullmatch(r"[a-f0-9]{24}", str(job.get("expected_microversion", ""))):
            raise BridgeError("UI writes require expected_microversion.")
    if kind == "native":
        name = job.get("command", "")
        if not is_allowed(name):
            raise BridgeError("Command is absent from the captured client schema; use native_catalog.")
        if not isinstance(job.get("body", {}), dict):
            raise BridgeError("Command body must be an object.")
        if name not in READS and not re.fullmatch(r"[a-f0-9]{24}", str(job.get("expected_microversion", ""))):
            raise BridgeError("Native writes require expected_microversion from native_state (preflight check, not an atomic lock).")
    return job


class Broker:
    def __init__(self, config):
        self.config = config
        self.extension = None
        self.extension_info = None
        self.pending = {}
        self.send_lock = asyncio.Lock()
        self.command_lock = asyncio.Lock()

    async def dispatch(self, job, timeout=50, redirects=0):
        validate_job(job)
        # Serialize all native transactions and browser requests. Timeouts are never replayed.
        async with self.command_lock:
            ws = self.extension
            if ws is None:
                raise BridgeError("Extension disconnected. Connect Onshape Native in Comet.")
            capabilities = (self.extension_info or {}).get("capabilities", [])
            # Document scoping lives in the extension; an older one cannot enforce it.
            if job.get("kind") != "tabs" and "policy_v2" not in capabilities:
                raise BridgeError("Extension policy is outdated; reload the Onshape Native extension (needs policy_v2).")
            if job.get("kind") == "display" and "display_v1" not in capabilities:
                raise BridgeError("Loaded extension lacks display_v1. Update/reload version 0.5.0; check bridge_status.")
            command_id = secrets.token_hex(16)
            future = asyncio.get_running_loop().create_future()
            self.pending[command_id] = future
            try:
                async with self.send_lock:
                    await ws.send_json({"type": "command", "id": command_id, "job": job})
                result = await asyncio.wait_for(future, timeout)
            except (asyncio.TimeoutError, WebSocketDisconnect, RuntimeError):
                raise BridgeError("Command outcome unknown. Inspect Onshape before retrying; no automatic replay.") from None
            finally:
                self.pending.pop(command_id, None)
        if job.get("kind") == "rest" and job.get("method") == "GET" and isinstance(result, dict) and result.get("download_redirect"):
            if redirects >= 5:
                raise BridgeError("Too many download redirects.")
            url = urlsplit(result["download_redirect"])
            if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
                raise BridgeError("Invalid download redirect.")
            if url.hostname == "cad.onshape.com":
                return await self.dispatch({**job, "path": url.path, "query": parse_qs(url.query)}, timeout, redirects + 1)
            if not url.hostname or not (S3_HOST.fullmatch(url.hostname) or url.hostname.endswith(".onshape.com")):
                raise BridgeError("Unrecognized export host; inspect the download workflow before extending the allowlist.")
            # Signed export URL from Onshape. This client has NO session cookies,
            # bridge token or API keys, and never forwards them to file storage.
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=45) as client:
                try:
                    async with client.stream("GET", result["download_redirect"], headers=job.get("request_headers", {})) as response:
                        if response.status_code in (401, 403) and re.fullmatch(r"cad-[a-z0-9-]+\.onshape\.com", url.hostname):
                            # Regional hosts want session cookies, which this client never sends.
                            raise BridgeError(f"Export host {url.hostname} returned HTTP {response.status_code}: it needs browser cookies, which are never forwarded. "
                                              "Export via a translation instead (create*Translation with formatName, storeInDocument=false; poll getTranslation; download resultExternalDataIds with downloadExternalData).")
                        if not 200 <= response.status_code < 300:
                            # Host only: the query carries the storage signature.
                            raise BridgeError(f"Export storage {url.hostname} returned HTTP {response.status_code}.")
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            raw.extend(chunk)
                            if len(raw) > 64 * 1024 * 1024:
                                raise BridgeError("Export exceeds 64 MiB.")
                        return {"status": response.status_code, "encoding": "base64", "body": base64.b64encode(raw).decode(),
                                "contentType": response.headers.get("content-type", "application/octet-stream"),
                                "response_headers": {k:v for k,v in response.headers.items() if k in {"etag", "content-disposition", "content-range"}}}
                except httpx.HTTPError:
                    raise BridgeError("Export download failed; no credentials were forwarded to file storage.") from None
        return result

    async def websocket(self, ws):
        origin = ws.headers.get("origin", "")
        if not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            # Mutual HMAC challenge: neither side sends the token, so a squatter on
            # the port learns nothing, and the extension accepts commands only
            # after the bridge proves it holds the token ("srv" mac).
            server_nonce = secrets.token_hex(16)
            await ws.send_json({"type": "challenge", "nonce": server_nonce})
            hello = await asyncio.wait_for(ws.receive_json(), 5)
            ext_nonce = hello.get("nonce") if isinstance(hello, dict) else None
            supplied = hello.get("mac") if isinstance(hello, dict) else None
            # Shape check first: compare_digest raises TypeError on non-ASCII str.
            if (not isinstance(ext_nonce, str) or not NONCE.fullmatch(ext_nonce) or not isinstance(supplied, str) or not MAC.fullmatch(supplied)
                    or not hmac.compare_digest(supplied, mac(self.config["token"], f"ext\n{server_nonce}\n{ext_nonce}")) or self.extension):
                await ws.close(code=1008)
                return
            self.extension = ws
            version = hello.get("version")
            capabilities = hello.get("capabilities", [])
            self.extension_info = {"version": version if isinstance(version, str) and len(version) < 50 else "unknown",
                                   "capabilities": [c for c in capabilities if isinstance(c, str) and len(c)<80][:30] if isinstance(capabilities, list) else []}
            async with self.send_lock:
                await ws.send_json({"type": "ready", "protocol": PROTOCOL, "mac": mac(self.config["token"], f"srv\n{ext_nonce}\n{server_nonce}")})
            while True:
                raw = await ws.receive_text()
                if len(raw.encode()) > MAX_BODY:
                    await ws.close(code=1009)
                    break
                message = json.loads(raw)
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "ping":
                    async with self.send_lock:
                        await ws.send_json({"type": "pong"})
                elif message.get("type") == "result":
                    future = self.pending.get(message.get("id"))
                    if future and not future.done():
                        future.set_result(message.get("result"))
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, RuntimeError):
            pass
        finally:
            if self.extension is ws:
                self.extension = None
                self.extension_info = None
                for future in self.pending.values():
                    if not future.done():
                        future.set_exception(BridgeError("Extension disconnected during command; outcome unknown. Inspect before retrying."))


def create_app(config=None):
    config = config or load_config()
    broker = Broker(config)

    seen = {}  # nonce -> signed ts, kept until the ts check alone refuses a replay

    async def authorized_body(request):
        """Raw body of a correctly signed, fresh, unreplayed request; else a refusal response."""
        expected_host = f"127.0.0.1:{config['port']}"
        if request.headers.get("host") != expected_host or request.headers.get("origin"):
            return JSONResponse({"error": "Origin or host refused."}, 403)
        unauthorized = JSONResponse({"error": "Unauthorized."}, 401)
        parts = re.fullmatch(r"ONH (\d{1,12}):([0-9a-f]{32}):([0-9a-f]{64})", request.headers.get("authorization", ""))
        now = time.time()
        if not parts or abs(now - int(parts[1])) > REPLAY_WINDOW:
            return unauthorized
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                return JSONResponse({"error": "Request exceeds 96 MiB."}, 413)
        # Sign exactly what arrived: encoded path (ids may contain %2F) plus raw query.
        path = request.scope.get("raw_path", request.url.path.encode()).decode("ascii")
        if request.scope.get("query_string"):
            path += "?" + request.scope["query_string"].decode("ascii")
        ts, nonce, supplied = parts.groups()
        if not hmac.compare_digest(supplied, mac(config["token"], request_message(request.method, path, ts, nonce, bytes(body)))):
            return unauthorized
        for old in [n for n, t in seen.items() if t < now - REPLAY_WINDOW]:
            del seen[old]
        if nonce in seen:
            return unauthorized
        if len(seen) >= MAX_NONCES:
            return JSONResponse({"error": "Too many signed requests; retry shortly."}, 429)
        seen[nonce] = int(ts)
        return bytes(body), nonce

    def authenticated(handler):
        """handler(request, body) for signed requests only. Its response is signed for the
        request nonce, so a port squatter cannot pose as the bridge to the MCP client."""
        async def endpoint(request):
            auth = await authorized_body(request)
            if isinstance(auth, Response):
                return auth
            body, nonce = auth
            response = await handler(request, body)
            response.headers["X-ONH-MAC"] = response_mac(config["token"], nonce, response.body)
            return response
        return endpoint

    async def health(request, body):
        return JSONResponse({"protocol": PROTOCOL, "extension_connected": broker.extension is not None,
                             "extension": broker.extension_info, "pending": len(broker.pending)})

    async def command(request, body):
        try:
            data = json.loads(body) if body else {}
            return JSONResponse(await broker.dispatch(data))
        except (BridgeError, ValueError) as error:
            return JSONResponse({"error": str(error)}, 400)

    async def local_tool(request, raw):
        # These Python conveniences deliberately live outside Onshape's /api/
        # namespace. They use the same companion/extension transport as MCP.
        from . import server
        from .client import OnshapeError
        import inspect
        from pydantic import validate_call
        names = {"artifact_page", "resolve_target", "search_commands", "browse_commands", "document_tree", "element_tree", "document_history", "document_edit", "sidebar_edit",
                 "display_state", "set_visibility", "mate_animation", "view_control", "capture_viewport"}
        name = request.path_params["tool"]
        if name not in names:
            return JSONResponse({"error": "Unknown local tool.", "tools": sorted(names)}, 404)
        try:
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict): raise ValueError("Tool arguments must be a JSON object.")
            function = getattr(server, name)
            inspect.signature(function).bind(**body)
            # HTTP callers receive the same argument constraints as MCP. In
            # particular, the string "false" must never enable deletion.
            result = validate_call(function, config={"strict": True})(**body)
            if inspect.isawaitable(result): result = await result
            if name == "capture_viewport":
                # MCP includes an ImageContent block; HTTP returns its artifact metadata.
                return JSONResponse(json.loads(result[0].text))
            return JSONResponse(json.loads(result))
        except (OnshapeError, BridgeError, ValueError, TypeError) as error:
            return JSONResponse({"error": str(error), "next": "Inspect current state before retrying a mutation."}, 400)

    async def rest(request, raw):
        try:
            query = {}
            for key, value in request.query_params.multi_items():
                if key in query:
                    query[key] = (query[key] if isinstance(query[key], list) else [query[key]]) + [value]
                else:
                    query[key] = value
            # Node/part IDs may contain encoded slashes. ASGI's decoded `path`
            # would turn those into route separators before forwarding.
            api_path = request.scope.get("raw_path", request.url.path.encode()).decode("ascii")
            job = {"kind": "rest", "method": request.method, "path": api_path, "query": query, "body": None}
            safe_headers = {k:request.headers[k] for k in ("if-none-match", "range") if k in request.headers}
            if safe_headers: job["request_headers"] = safe_headers
            if "accept" in request.headers and request.headers["accept"] != "*/*": job["accept"] = request.headers["accept"]
            content_type = request.headers.get("content-type", "application/json")
            if request.method != "GET":
                if "json" in content_type.lower():
                    job["body"] = json.loads(raw) if raw else {}
                    if job["body"] is None:
                        job["body_present"] = True
                else:
                    if len(raw) > 64 * 1024 * 1024:
                        raise BridgeError("Upload exceeds 64 MiB.")
                    job.update({"body_base64": base64.b64encode(raw).decode(), "content_type": content_type})
            result = await broker.dispatch(job)
            if not isinstance(result, dict):
                raise BridgeError("Page returned no structured result; outcome unknown. Inspect before retrying.")
            if result.get("error"):
                return JSONResponse(result, 502)
            status = result.get("status", 200)
            response_headers = {k:v for k,v in result.get("response_headers", {}).items() if k.lower() in {"etag", "content-disposition", "content-range", "retry-after", "x-rate-limit-remaining", "x-ratelimit-remaining"}}
            if status in {204,304}:
                return Response(status_code=status, headers=response_headers)
            if result.get("encoding") == "base64":
                return Response(base64.b64decode(result["body"]), status_code=status,
                                media_type=result.get("contentType", "application/octet-stream"), headers=response_headers)
            return JSONResponse(result.get("body"), status, headers=response_headers)
        except (BridgeError, ValueError) as error:
            return JSONResponse({"error": str(error)}, 400)

    app = Starlette(routes=[Route("/health", authenticated(health)), Route("/command", authenticated(command), methods=["POST"]),
                           Route("/local/{tool}", authenticated(local_tool), methods=["POST"]),
                           WebSocketRoute("/extension", broker.websocket),
                           Route("/api/{path:path}", authenticated(rest), methods=["GET", "POST", "PUT", "PATCH", "DELETE"])])
    app.state.broker = broker
    return app


@asynccontextmanager
async def running_bridge():
    """Reuse an authenticated bridge or own one for this MCP process lifetime."""
    config = load_config()
    nonce = secrets.token_hex(16)
    async with httpx.AsyncClient(trust_env=False) as client:
        try:
            response = await client.get(f"http://127.0.0.1:{config['port']}/health",
                                        headers={"Authorization": sign_request(config["token"], "GET", "/health", nonce=nonce)}, timeout=1)
        except httpx.HTTPError:
            response = None
    if response is not None:
        # Only a bridge holding the token can sign the reply for this nonce.
        if (response.status_code != 200 or not response_valid(config["token"], nonce, response.content, response.headers.get("x-onh-mac"))
                or response.json().get("protocol") != PROTOCOL):
            raise BridgeError("Port is occupied by another service or a bridge with another token.")
        yield
        return
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", config["port"]))
    server = uvicorn.Server(uvicorn.Config(create_app(config), log_level="warning", access_log=False,
                                           ws_max_size=MAX_BODY))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        for _ in range(100):
            if server.started:
                break
            if task.done():
                await task
                raise BridgeError("Bridge failed to start.")
            await asyncio.sleep(.05)
        if not server.started:
            raise BridgeError("Bridge startup timed out.")
        yield
    finally:
        server.should_exit = True
        await task
        sock.close()
