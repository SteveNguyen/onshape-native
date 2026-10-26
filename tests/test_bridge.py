import asyncio
import json

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from onshape_native.bridge import Broker, BridgeError, create_app, running_bridge, validate_job
from onshape_native.client import BridgeAuth, OnshapeError
from onshape_native.config import mac, response_mac, sign_request
from onshape_native.native_catalog import catalog

CONFIG = {"host": "127.0.0.1", "port": 8766, "token": "test-" * 10}
TARGET = {"did": "a" * 24, "wid": "b" * 24, "eid": "c" * 24}
AUTH = BridgeAuth(CONFIG["token"])
ORIGIN = {"origin": "chrome-extension://" + "a" * 32}


def signed(method, path, body=b""):
    """Signed request header without response verification, to observe refusals."""
    return {"Authorization": sign_request(CONFIG["token"], method, path, body)}


def bridge_response(request, status=200, token=CONFIG["token"], **kwargs):
    """A response signed as the real bridge signs it for this request's nonce."""
    response = httpx.Response(status, **kwargs)
    nonce = request.headers["authorization"].split(":")[1]
    response.headers["X-ONH-MAC"] = response_mac(token, nonce, response.content)
    return response


def handshake(ws, token=CONFIG["token"], **info):
    """Answer the bridge challenge as the extension does; returns (server_nonce, ext_nonce)."""
    challenge = ws.receive_json()
    assert challenge["type"] == "challenge" and len(challenge["nonce"]) == 32
    nonce = "e" * 32
    ws.send_json({"type": "hello", "nonce": nonce, "mac": mac(token, f"ext\n{challenge['nonce']}\n{nonce}"), **info})
    return challenge["nonce"], nonce


async def test_http_auth_host_origin_and_offline_behavior():
    app = create_app(CONFIG)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766") as client:
        assert (await client.get("/health")).status_code == 401
        assert (await client.get("/health", headers={"Authorization": "Bearer " + CONFIG["token"]})).status_code == 401
        assert (await client.get("/health", headers={**signed("GET", "/health"), "Origin": "https://evil.example"})).status_code == 403
        assert (await client.get("/health", headers={**signed("GET", "/health"), "Host": "evil.example"})).status_code == 403
        health = (await client.get("/health", auth=AUTH)).json()
        assert health["extension_connected"] is False and health["protocol"] == 2
        response = await client.post("/command", auth=AUTH, json={"kind": "tabs"})
        assert response.status_code == 400 and "disconnected" in response.json()["error"]


async def test_signed_requests_reject_replay_stale_and_tampering():
    import time
    app = create_app(CONFIG)
    token, body = CONFIG["token"], b'{"kind": "tabs"}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766") as c:
        async def post(header, content=body, path="/command"):
            return (await c.post(path, content=content, headers={"Authorization": header})).status_code
        signed = sign_request(token, "POST", "/command", body)
        assert await post(signed) == 400  # authenticated; extension offline
        assert await post(signed) == 401  # replayed nonce
        assert await post(sign_request(token, "POST", "/command", body, ts=int(time.time()) - 61)) == 401
        assert await post(sign_request(token, "POST", "/command", body, ts=int(time.time()) + 61)) == 401
        assert await post(sign_request(token, "POST", "/command", body), content=b'{"kind": "open"}') == 401
        assert await post(sign_request(token, "GET", "/command", body)) == 401
        assert await post(sign_request(token, "POST", "/command", body), path="/command?x=1") == 401
        assert await post(sign_request("other-" * 8, "POST", "/command", body)) == 401
        for header in ["ONH", "ONH 1:2", "ONH x:y:z", "ONH " + "1" * 400]:
            assert await post(header) == 401
        query = await c.get("/health?probe=1", auth=AUTH)
        assert query.status_code == 200


async def test_client_and_health_probe_never_send_the_token(monkeypatch):
    """A process squatting on 127.0.0.1:8766 sees only single-use signatures."""
    from onshape_native.client import Client
    seen = []
    def squatter(request):
        seen.append(request)
        return httpx.Response(200, json={"protocol": 1})
    monkeypatch.setattr("onshape_native.client.load_config", lambda: CONFIG)
    client = Client(transport=httpx.MockTransport(squatter))
    # Unsigned responses are refused, so a squatter cannot feed results to tools.
    with pytest.raises(OnshapeError, match="signature"):
        await client.status()
    with pytest.raises(OnshapeError, match="signature"):
        await client.command({"kind": "tabs"})
    await client.close()
    real_client = httpx.AsyncClient
    monkeypatch.setattr("onshape_native.bridge.load_config", lambda: CONFIG)
    monkeypatch.setattr("onshape_native.bridge.httpx.AsyncClient", lambda **kw: real_client(**kw, transport=httpx.MockTransport(squatter)))
    with pytest.raises(BridgeError, match="occupied"):
        async with running_bridge(): pass
    assert len(seen) == 3
    for request in seen:
        wire = str(request.url) + str(request.headers.raw) + request.content.decode()
        assert CONFIG["token"] not in wire and request.headers["authorization"].startswith("ONH ")


@pytest.mark.parametrize("respond", [
    lambda r: httpx.Response(200, json={"protocol": 2}),  # replays the public health shape
    lambda r: httpx.Response(200, json={"protocol": 2}, headers={"X-ONH-MAC": "0" * 64}),
    lambda r: bridge_response(r, json={"protocol": 2}, token="other-" * 8),
    lambda r: httpx.Response(200, json={"protocol": 2}, headers={"X-ONH-MAC": "é".encode("latin-1") * 64}),
])
async def test_squatter_without_valid_response_mac_is_rejected(monkeypatch, respond):
    from onshape_native.client import Client
    monkeypatch.setattr("onshape_native.client.load_config", lambda: CONFIG)
    client = Client(transport=httpx.MockTransport(respond))
    with pytest.raises(OnshapeError, match="signature"):
        await client.status()
    await client.close()
    real_client = httpx.AsyncClient
    monkeypatch.setattr("onshape_native.bridge.load_config", lambda: CONFIG)
    monkeypatch.setattr("onshape_native.bridge.httpx.AsyncClient", lambda **kw: real_client(**kw, transport=httpx.MockTransport(respond)))
    with pytest.raises(BridgeError, match="occupied"):
        async with running_bridge(): pass


async def test_running_bridge_reuses_a_bridge_that_signs_responses(monkeypatch):
    real_client = httpx.AsyncClient
    monkeypatch.setattr("onshape_native.bridge.load_config", lambda: CONFIG)
    monkeypatch.setattr("onshape_native.bridge.httpx.AsyncClient",
                        lambda **kw: real_client(**kw, transport=httpx.MockTransport(lambda r: bridge_response(r, json={"protocol": 2}))))
    async with running_bridge(): pass


async def test_every_authenticated_response_is_signed_for_its_request_nonce():
    app = create_app(CONFIG)
    async def dispatch(job): return {"status": 200, "body": {"ok": True}}
    app.state.broker.dispatch = dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766") as c:
        for method, path, body in [("GET", "/health", b""), ("POST", "/command", b"[]"), ("GET", "/api/v6/documents/x", b""),
                                   ("POST", "/local/nope", b"{}")]:
            header = sign_request(CONFIG["token"], method, path, body)
            response = await c.request(method, path, content=body, headers={"Authorization": header})
            assert response.headers["x-onh-mac"] == response_mac(CONFIG["token"], header.split(":")[1], response.content), path
        refused = await c.get("/health")
        assert refused.status_code == 401 and "x-onh-mac" not in refused.headers
        # The verifying client accepts the real bridge.
        assert (await c.get("/health", auth=AUTH)).json()["protocol"] == 2


async def test_local_discovery_auth_offline_and_allowlisted_dispatch():
    app = create_app(CONFIG)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766") as c:
        path = "/local/search_commands"
        assert (await c.post(path, json={"task":"create an assembly"})).status_code == 401
        assert (await c.post(path, headers={**signed("POST", path, b"{}"), "Origin":"https://evil.example"}, content=b"{}")).status_code == 403
        result = await c.post(path, auth=AUTH, json={"task":"create an assembly"})
        assert result.status_code == 200 and len(result.json()["matches"]) == 10
        expanded = await c.post("/local/artifact_page", auth=AUTH,
                                json={"artifact":result.json()["artifact"],"pointer":"/manual_fallback"})
        assert expanded.status_code == 200 and "data" in expanded.json()
        assert (await c.post("/local/artifact_page", json={})).status_code == 401
        assert (await c.post("/local/api_write", auth=AUTH, json={})).status_code == 404
        for args in [[], {}, {"task":"create", "unknown":True}, {"task":"create", "limit":"10"}]:
            assert (await c.post(path, auth=AUTH, json=args)).status_code == 400
        all_rest = await c.post("/local/browse_commands", auth=AUTH, json={"source":"rest", "limit":1})
        assert all_rest.json()["total"] == 302 and all_rest.json()["next_offset"] == 1
        bad_delete = await c.post("/local/document_edit", auth=AUTH,
                                  json={"snapshot":"not-read", "action":"delete_folder", "delete_contents":"false"})
        assert bad_delete.status_code == 400 and "bool" in bad_delete.json()["error"]
        url = "https://cad.onshape.com/documents/" + "a"*24 + "/w/" + "b"*24
        resolved = await c.post("/local/resolve_target", auth=AUTH, json={"url":url})
        assert resolved.status_code == 200 and resolved.json()["target"]["eid"] is None
        invalid = await c.post("/local/resolve_target", auth=AUTH, json={"url":url,"tab_id":True})
        assert invalid.status_code == 400


@pytest.mark.parametrize("path", ["https://evil.example/api/x", "//evil.example/api/x", "/api/../users", "/api/%252e%252e/users", "/api/x?x=1", "/api/x%23y", "/api/clientinfo/xsrf", "/api/v14/apikeys",
    "/api/v6/documents;x=1", "/api/v6/documents%3Bx", "/api/v6/d%252Fx", "/api/v6/docu\tments", "/api/v6/documents%09", "/api/v6/x\n", "/api/v6/x%5Cy", "/api/v6/x\\y", "/api/v6/%E0%A4%A"])
def test_no_arbitrary_origins_traversal_or_auth_export(path):
    with pytest.raises(BridgeError):
        validate_job({"kind": "rest", "path": path, "method": "GET"})


def test_native_target_evidence_and_revision_are_required():
    job = {"kind": "native", "command": "partstudiofolders.GBTUiCreateFolder", "body": {}, "target": TARGET}
    with pytest.raises(BridgeError, match="microversion"):
        validate_job(job)
    assert validate_job({**job, "expected_microversion": "d" * 24})
    with pytest.raises(BridgeError, match="schema"):
        validate_job({**job, "command": "executeJavascript", "expected_microversion": "d" * 24})
    with pytest.raises(BridgeError, match="target"):
        validate_job({"kind": "state", "target": {"did": "a" * 24}})


async def test_timeout_is_not_replayed_and_late_result_cannot_resolve_next_command():
    broker = Broker(CONFIG)
    class Connection:
        sent = []
        async def send_json(self, data): self.sent.append(data)
    broker.extension = Connection()
    with pytest.raises(BridgeError, match="outcome unknown"):
        await broker.dispatch({"kind": "tabs"}, timeout=.01)
    assert len(broker.extension.sent) == 1
    assert not broker.pending
    task = asyncio.create_task(broker.dispatch({"kind": "tabs"}, timeout=1))
    await asyncio.sleep(.01)
    assert broker.extension.sent[0]["id"] != broker.extension.sent[1]["id"]
    broker.pending[broker.extension.sent[1]["id"]].set_result({"tabs": []})
    assert await task == {"tabs": []}


async def test_extension_without_policy_v1_only_lists_tabs():
    broker = Broker(CONFIG)
    class Connection:
        sent = []
        async def send_json(self, data):
            self.sent.append(data); broker.pending[data["id"]].set_result({"ok": True})
    broker.extension = Connection()
    broker.extension_info = {"version": "0.4.0", "capabilities": ["tab_context_v1", "display_v1"]}
    for job in [{"kind": "state", "target": TARGET}, {"kind": "rest", "method": "GET", "path": "/api/v6/documents/" + "a"*24}]:
        with pytest.raises(BridgeError, match="policy_v1.*[Rr]eload"):
            await broker.dispatch(job)
    assert not broker.extension.sent
    assert await broker.dispatch({"kind": "tabs"}) == {"ok": True}
    broker.extension_info["capabilities"].append("policy_v1")
    assert await broker.dispatch({"kind": "state", "target": TARGET}) == {"ok": True}


async def test_extension_policy_refusal_reaches_tools_as_onshape_error(monkeypatch):
    from onshape_native.client import Client, OnshapeError
    monkeypatch.setattr("onshape_native.client.load_config", lambda: CONFIG)
    refusal = "Document " + "b"*24 + " is not authorized. Ask the user to authorize it in the Onshape Native extension popup."
    client = Client(transport=httpx.MockTransport(lambda request: bridge_response(request, json={"error": refusal})))
    with pytest.raises(OnshapeError, match="not authorized.*popup"):
        await client.request("GET", "/api/v6/documents/" + "b"*24)
    await client.close()


def test_page_adapter_native_allowlists_match_python_catalog():
    import re
    from pathlib import Path
    from onshape_native.native_catalog import READS, VERIFIED
    source = (Path(__file__).resolve().parents[1] / "extension/page-adapter.js").read_text()
    sets = {name: set(re.findall(r'"([\w.]+)"', body)) for name, body in re.findall(r"const (allowed|reads) = new Set\(\[(.*?)\]\)", source, re.S)}
    assert sets["reads"] == READS
    assert VERIFIED <= sets["allowed"] | sets["reads"]


def test_websocket_requires_extension_origin_and_mutual_hmac():
    with TestClient(create_app(CONFIG), base_url="http://127.0.0.1:8766") as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/extension", headers={"origin": "https://evil.example"}): pass
        with client.websocket_connect("/extension", headers=ORIGIN) as ws:
            server_nonce, ext_nonce = handshake(ws, version="0.5.0", capabilities=["policy_v1"])
            ready = ws.receive_json()
            # The bridge proves it holds the token without revealing it.
            assert ready == {"type": "ready", "protocol": 2, "mac": mac(CONFIG["token"], f"srv\n{ext_nonce}\n{server_nonce}")}
            assert CONFIG["token"] not in json.dumps(ready)
            health = client.get("/health", auth=AUTH).json()
            assert health["extension_connected"] is True and health["extension"]["capabilities"] == ["policy_v1"]
            with client.websocket_connect("/extension", headers=ORIGIN) as second:  # single extension
                handshake(second)
                with pytest.raises(WebSocketDisconnect): second.receive_json()
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}
        assert client.get("/health", auth=AUTH).json()["extension_connected"] is False


@pytest.mark.parametrize("hello", [
    lambda n: {"type": "hello", "token": CONFIG["token"]},  # protocol 1 hello
    lambda n: {"type": "hello", "nonce": "e" * 32, "mac": mac("other-" * 8, f"ext\n{n}\n{'e' * 32}")},
    lambda n: {"type": "hello", "nonce": "e" * 32, "mac": mac(CONFIG["token"], f"srv\n{'e' * 32}\n{n}")},  # reflected label
    lambda n: {"type": "hello", "nonce": "short", "mac": mac(CONFIG["token"], f"ext\n{n}\nshort")},
    lambda n: {"type": "hello", "nonce": "e" * 32, "mac": 1},
    lambda n: {"type": "hello", "nonce": "e" * 32, "mac": "é" * 64},  # compare_digest raises on non-ASCII str
    lambda n: {"type": "hello", "nonce": "e" * 32, "mac": mac(CONFIG["token"], f"ext\n{n}\n{'e' * 32}").upper()},
])
def test_websocket_refuses_bad_hello(hello):
    with TestClient(create_app(CONFIG), base_url="http://127.0.0.1:8766") as client:
        with client.websocket_connect("/extension", headers=ORIGIN) as ws:
            ws.send_json(hello(ws.receive_json()["nonce"]))
            with pytest.raises(WebSocketDisconnect): ws.receive_json()
        assert client.get("/health", auth=AUTH).json()["extension_connected"] is False


async def test_rest_preserves_path_query_json_and_status():
    app = create_app(CONFIG)
    seen = []
    async def dispatch(job):
        seen.append(job)
        return {"status": 201, "body": {"id": "created"}}
    app.state.broker.dispatch = dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766", auth=AUTH) as client:
        response = await client.post("/api/v17/documents?x=1&x=2", json={"name": "Example", "isPublic": False})
    assert response.status_code == 201 and response.json() == {"id": "created"}
    assert seen == [{"kind": "rest", "method": "POST", "path": "/api/v17/documents", "query": {"x": ["1", "2"]}, "body": {"name": "Example", "isPublic": False}}]


async def test_json_content_type_is_matched_case_insensitively():
    app = create_app(CONFIG)
    seen = []
    async def dispatch(job):
        seen.append(job)
        return {"status": 200, "body": {}}
    app.state.broker.dispatch = dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766", auth=AUTH) as client:
        await client.post("/api/v6/documents/" + "a" * 24, content=b'{"isPublic": true}', headers={"Content-Type": "Application/JSON"})
    assert seen[0]["body"] == {"isPublic": True} and "body_base64" not in seen[0]


def test_captured_evidence_contains_geometry_dimensions_and_folders():
    names = {row["command"] for row in catalog()}
    assert {"ui.sketch.GBTUiSketchAddRectangleCall", "ui.sketch.GBTUiSketchAddCircleCall", "ui.sketch.GBTUiSketchModifyDimensionCall", "partstudiofolders.GBTUiCreateFolder"} <= names
    assert next(row for row in catalog() if row["command"] == "ui.GBTUiMassPropCall")["replay_verified"]


async def test_binary_upload_download_and_empty_success():
    import base64
    app = create_app(CONFIG)
    seen = []
    async def dispatch(job):
        seen.append(job)
        if job["method"] == "DELETE": return {"status": 204, "body": {}}
        return {"status": 200, "encoding": "base64", "body": base64.b64encode(b"\x00\xffSTEP").decode(), "contentType": "application/octet-stream"}
    app.state.broker.dispatch = dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8766", auth=AUTH) as c:
        r = await c.post("/api/v17/blobelements", content=b"\x00\xffupload", headers={"Content-Type":"multipart/form-data; boundary=test"})
        assert r.content == b"\x00\xffSTEP"
        assert base64.b64decode(seen[0]["body_base64"]) == b"\x00\xffupload"
        assert seen[0]["content_type"] == "multipart/form-data; boundary=test"
        r = await c.delete("/api/v17/documents/test")
        assert r.status_code == 204 and not r.content


def test_ui_fallback_requires_reason_snapshot_and_revision():
    job = {"kind":"ui_action", "target":TARGET, "action":"click", "control":0,
           "snapshot":"snapshot", "expected_microversion":"d"*24}
    with pytest.raises(BridgeError, match="backend"):
        validate_job(job)
    assert validate_job({**job, "backend_unavailable_reason":"Opening an editor-only view panel"})


@pytest.mark.parametrize('job', [
    {'kind':'rest','path':42,'method':'GET'},
    {'kind':'rest','path':'/api/documents','method':'GET','query':[]},
    {'kind':'state','target':None},
    {'kind':'state','target':[]},
])
def test_malformed_jobs_are_validation_errors(job):
    with pytest.raises(BridgeError): validate_job(job)


async def test_conditional_range_headers_and_json_shapes():
    app=create_app(CONFIG);seen=[]
    async def dispatch(job):
        seen.append(job)
        if job['method']=='GET': return {'status':304,'body':None,'response_headers':{'etag':'sample-etag'}}
        return {'status':200,'body':job['body']}
    app.state.broker.dispatch=dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://127.0.0.1:8766',auth=AUTH) as c:
        r=await c.get('/api/v17/documents',headers={'If-None-Match':'sample-etag','Range':'bytes=0-99'})
        assert r.status_code==304 and not r.content and r.headers['etag']=='sample-etag'
        assert seen[-1]['request_headers']=={'if-none-match':'sample-etag','range':'bytes=0-99'}
        for value in ([{'a':1}],42,'value',None):
            r=await c.post('/api/v17/documents',content=json.dumps(value),headers={'Content-Type':'application/json'})
            assert r.json()==value


def test_authentication_is_browser_owned_but_userinfo_is_available():
    with pytest.raises(BridgeError,match='Authentication'):
        validate_job({'kind':'rest','method':'POST','path':'/api/v17/users/session'})
    assert validate_job({'kind':'rest','method':'GET','path':'/api/v17/users/sessioninfo'})


@pytest.mark.parametrize('host',['sample.s3.amazonaws.com','my.bucket.s3.us-east-1.amazonaws.com','bucket.s3-us-west-2.amazonaws.com','files.onshape.com',
    's3.amazonaws.com','s3.us-east-1.amazonaws.com','s3-us-west-2.amazonaws.com'])
async def test_signed_export_download_never_forwards_bridge_credentials(monkeypatch,host):
    import base64
    real_client=httpx.AsyncClient
    seen=[]
    def download(request):
        seen.append(request)
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        return httpx.Response(200,content=b'binary-stl',headers={'content-type':'application/octet-stream'})
    monkeypatch.setattr('onshape_native.bridge.httpx.AsyncClient',lambda **kwargs:real_client(**kwargs,transport=httpx.MockTransport(download)))
    broker=Broker(CONFIG)
    class Extension:
        async def send_json(self,data):
            broker.pending[data['id']].set_result({'status':307,'download_redirect':f'https://{host}/export?signature=sample'})
    broker.extension=Extension();broker.extension_info={'version':'0.5.0','capabilities':['policy_v1']}
    result=await broker.dispatch({'kind':'rest','method':'GET','path':'/api/v17/partstudios/sample/stl'})
    assert base64.b64decode(result['body'])==b'binary-stl' and len(seen)==1


@pytest.mark.parametrize('url',['http://127.0.0.1/secrets','https://localhost/secrets','https://evil.example/file','https://cad.onshape.com@evil.example/file',
    'https://evil.execute-api.us-east-1.amazonaws.com/x','https://x.cloudfront.net/x','https://ec2-1-2-3-4.compute.amazonaws.com/x','https://s3.amazonaws.com.evil.example/x','https://amazonaws.com/x'])
async def test_export_redirect_cannot_access_arbitrary_hosts(url):
    broker=Broker(CONFIG)
    class Extension:
        async def send_json(self,data):broker.pending[data['id']].set_result({'status':307,'download_redirect':url})
    broker.extension=Extension();broker.extension_info={'version':'0.5.0','capabilities':['policy_v1']}
    with pytest.raises(BridgeError):
        await broker.dispatch({'kind':'rest','method':'GET','path':'/api/v17/partstudios/sample/stl'})


async def test_export_storage_error_names_host_but_not_signed_url(monkeypatch):
    real_client=httpx.AsyncClient
    monkeypatch.setattr('onshape_native.bridge.httpx.AsyncClient',lambda **kwargs:real_client(**kwargs,transport=httpx.MockTransport(lambda r:httpx.Response(401))))
    broker=Broker(CONFIG)
    class Extension:
        async def send_json(self,data):
            broker.pending[data['id']].set_result({'status':307,'download_redirect':'https://bucket.s3.amazonaws.com/export?signature=secret'})
    broker.extension=Extension();broker.extension_info={'version':'0.5.0','capabilities':['policy_v1']}
    with pytest.raises(BridgeError) as error:
        await broker.dispatch({'kind':'rest','method':'GET','path':'/api/v17/partstudios/sample/stl'})
    assert 'bucket.s3.amazonaws.com' in str(error.value) and '401' in str(error.value) and 'secret' not in str(error.value)


@pytest.mark.parametrize('status',[401,403])
async def test_regional_export_host_refusal_points_to_translation(monkeypatch,status):
    real_client=httpx.AsyncClient
    monkeypatch.setattr('onshape_native.bridge.httpx.AsyncClient',lambda **kwargs:real_client(**kwargs,transport=httpx.MockTransport(lambda r:httpx.Response(status))))
    broker=Broker(CONFIG)
    class Extension:
        async def send_json(self,data):
            broker.pending[data['id']].set_result({'status':307,'download_redirect':'https://cad-usw2.onshape.com/api/export?signature=secret'})
    broker.extension=Extension();broker.extension_info={'version':'0.5.0','capabilities':['policy_v1']}
    with pytest.raises(BridgeError) as error:
        await broker.dispatch({'kind':'rest','method':'GET','path':'/api/v17/partstudios/sample/stl'})
    assert str(status) in str(error.value) and 'translation' in str(error.value) and 'formatName' in str(error.value) and 'secret' not in str(error.value)


async def test_raw_http_preserves_encoded_entity_ids_and_explicit_json_null():
    app=create_app(CONFIG);seen=[]
    async def dispatch(job):seen.append(job);return {'status':200,'body':{}}
    app.state.broker.dispatch=dispatch
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://127.0.0.1:8766',auth=AUTH) as c:
        await c.get('/api/v17/assemblies/instance/nodeid/MOGxWy5ZQOQ%2FeBNbO')
        assert seen[-1]['path'].endswith('MOGxWy5ZQOQ%2FeBNbO')
        await c.post('/api/v17/documents',content='null',headers={'Content-Type':'application/json'})
        assert seen[-1]['body'] is None and seen[-1]['body_present'] is True
