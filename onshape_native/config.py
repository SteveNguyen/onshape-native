"""Local bridge settings. Onshape session credentials never leave the browser."""
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def runtime_dir():
    return Path(os.environ.get("ONSHAPE_NATIVE_RUNTIME", ROOT / ".runtime")).expanduser()


def load_config():
    root = runtime_dir()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    path = root / "bridge.json"
    if not path.exists():
        data = {"host": "127.0.0.1", "port": 8766, "token": secrets.token_urlsafe(32)}
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream, indent=2)
    data = json.loads(path.read_text())
    if data.get("host") != "127.0.0.1" or data.get("port") != 8766:
        raise ValueError("This extension is paired with 127.0.0.1:8766.")
    if not isinstance(data.get("token"), str) or len(data["token"]) < 32:
        raise ValueError("Bridge token must contain at least 32 characters.")
    path.chmod(0o600)
    return data


# The pairing token never crosses a socket: whoever binds 127.0.0.1:8766 first
# (possibly another local process) sees only single-use HMACs.
def mac(token, message):
    return hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest()


def request_message(method, path, ts, nonce, body):
    """Signed bridge request: method, raw path with query, timestamp, nonce, body digest."""
    return f"{method}\n{path}\n{ts}\n{nonce}\n{hashlib.sha256(body or b'').hexdigest()}"


def response_mac(token, nonce, body):
    """Bridge response signature, bound to the request nonce so a squatter cannot replay one."""
    return mac(token, f"resp\n{nonce}\n{hashlib.sha256(body or b'').hexdigest()}")


def response_valid(token, nonce, body, supplied):
    # compare_digest raises on non-ASCII str; validate the shape first.
    return isinstance(supplied, str) and len(supplied) == 64 and all(c in "0123456789abcdef" for c in supplied) \
        and hmac.compare_digest(supplied, response_mac(token, nonce, body))


def sign_request(token, method, path, body=b"", ts=None, nonce=None):
    """Authorization header value for one bridge HTTP request."""
    ts = int(time.time()) if ts is None else ts
    nonce = nonce or secrets.token_hex(16)
    return f"ONH {ts}:{nonce}:" + mac(token, request_message(method, path, ts, nonce, body))
