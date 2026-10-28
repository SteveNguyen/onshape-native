"""Browser-session transport. No Onshape keys, cookies, or HMAC in this package."""
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
import base64
import copy
import json
import re
import secrets

import httpx

from .config import load_config, response_valid, runtime_dir, sign_request

PINNED = re.compile(r"/[mv]/[0-9a-f]{24}(?:/|$)")
CACHE_ENTRY_MAX = 8 * 1024 * 1024  # larger answers (exports, big trees) are not kept


class OnshapeError(Exception):
    pass


class BridgeAuth(httpx.Auth):
    """Signs each final request (path, query and body bytes) instead of sending the token,
    and accepts only responses the bridge signed for that request's nonce."""
    requires_request_body = True
    requires_response_body = True

    def __init__(self, token):
        self.token = token

    def auth_flow(self, request):
        nonce = secrets.token_hex(16)
        request.headers["Authorization"] = sign_request(self.token, request.method, request.url.raw_path.decode("ascii"), request.content, nonce=nonce)
        response = yield request
        if not response_valid(self.token, nonce, response.content, response.headers.get("x-onh-mac")):
            raise OnshapeError("Bridge response signature missing or invalid; another process may hold 127.0.0.1:8766, or the bridge token differs.")


@dataclass
class Settings:
    base_url: str = "https://cad.onshape.com"
    cache_dir: Path = field(default_factory=lambda: runtime_dir() / "artifacts")

    @classmethod
    def load(cls):
        return cls()


class Client:
    def __init__(self, settings=None, transport=None):
        self.settings = settings or Settings.load()
        config = load_config()
        self.http = httpx.AsyncClient(base_url=f"http://127.0.0.1:{config['port']}",
                                      auth=BridgeAuth(config["token"]),
                                      timeout=110, follow_redirects=False, trust_env=False, transport=transport)
        self.calls = 0
        self.rate = {}
        # Answers to reads pinned to a revision (/m/<id>/ or /v/<id>/) never change: repeats are served locally,
        # which is what keeps Onshape's per-endpoint daily budgets (often ~500 calls) far from exhaustion.
        self.cache, self.cache_hits, self.cache_limit = OrderedDict(), 0, 256

    async def close(self):
        await self.http.aclose()

    async def command(self, job):
        try:
            response = await self.http.post("/command", json=job)
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise OnshapeError("Local bridge unavailable or command outcome unknown. Inspect state before retrying.") from None
        if not isinstance(data, dict):
            raise OnshapeError("Page returned no structured result; outcome unknown. Inspect state before retrying.")
        if response.status_code != 200 or data.get("error"):
            raise OnshapeError(data.get("error", "Bridge rejected the command."))
        return data

    async def status(self):
        try:
            response = await self.http.get("/health")
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError:
            return {"bridge_connected": False, "extension_connected": False}

    async def request(self, method, path, query=None, body=None, *, read_only=False):
        key = None
        if (method == "GET" or read_only) and PINNED.search(path):
            key = json.dumps([method, path, query or {}, body], sort_keys=True, default=str)
            if key in self.cache:
                self.cache.move_to_end(key)
                self.cache_hits += 1
                return copy.deepcopy(self.cache[key])
        self.calls += 1
        data = await self.command({"kind": "rest", "method": method, "path": path,
                                   "query": query or {}, "body": body})
        result = self._result(method, path, data)
        if key is not None and len(json.dumps(result, default=str) if not isinstance(result, bytes) else result) <= CACHE_ENTRY_MAX:
            self.cache[key] = copy.deepcopy(result)
            while len(self.cache) > self.cache_limit:
                self.cache.popitem(last=False)
        return result

    def _result(self, method, path, data):
        status = data.get("status", 0)
        if status == 429:
            # Onshape rate-limits each endpoint; the extension now refuses it locally until Retry-After passes.
            wait = data.get("response_headers", {}).get("retry-after")
            when = f" for about {int(wait) / 3600:.1f} h" if str(wait).isdigit() and int(wait) >= 3600 else \
                   f" for {wait} s" if str(wait).isdigit() else ""
            raise OnshapeError(f"Onshape HTTP 429 (rate limit) on {method} {path}: Onshape asks to wait{when}. "
                               "Do not retry or work around it with other endpoints; tell the user.")
        if not 200 <= status < 300:
            raise OnshapeError(f"Onshape browser HTTP {status}. Inspect state before retrying writes.")
        if data.get("encoding") == "base64":
            return base64.b64decode(data["body"])
        return data.get("body", {})
