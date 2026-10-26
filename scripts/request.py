#!/usr/bin/env python3
"""Authenticated HTTP CLI: JSON body from a file or stdin, never shell interpolation."""
import argparse
import json
from pathlib import Path
import secrets
import sys
import urllib.request
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from onshape_native.config import load_config, response_valid, sign_request

p = argparse.ArgumentParser()
p.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
p.add_argument("path")
p.add_argument("--body", help="JSON file, or - for stdin")
a = p.parse_args()
if not a.path.startswith("/") or a.path.startswith("//"):
    p.error("Use a local absolute path such as /health or /command")
config = load_config()
body = None
if a.body:
    body = json.dumps(json.loads(sys.stdin.read() if a.body == "-" else Path(a.body).read_text())).encode()
nonce = secrets.token_hex(16)
req = urllib.request.Request(f"http://127.0.0.1:{config['port']}" + a.path, data=body, method=a.method,
    headers={"Authorization": sign_request(config["token"], a.method, a.path, body, nonce=nonce), "Content-Type": "application/json"})


def verified(response):
    """Body of a response the bridge signed for this request; a port squatter cannot sign."""
    data = response.read()
    if not response_valid(config["token"], nonce, data, response.headers.get("X-ONH-MAC")):
        sys.exit("Bridge response signature missing or invalid; another process may hold the port, or the token differs.")
    return data.decode()


try:
    with urllib.request.urlopen(req, timeout=110) as response:
        print(verified(response))
except urllib.error.HTTPError as error:
    print(verified(error), file=sys.stderr)
    sys.exit(1)
