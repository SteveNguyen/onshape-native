import os

import pytest

from onshape_native.client import OnshapeError
from onshape_native.server import upload_source


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("ONSHAPE_NATIVE_RUNTIME", str(tmp_path / "runtime"))
    (tmp_path / "outside.step").write_text("secret")
    return tmp_path / "runtime" / "uploads"


def test_upload_dir_is_created_private_and_accepts_files_inside(uploads):
    with pytest.raises(OnshapeError, match="Ask the user"):
        upload_source("missing.step")
    assert uploads.is_dir() and uploads.stat().st_mode & 0o777 == 0o700
    (uploads / "sub").mkdir()
    (uploads / "sub" / "part.step").write_text("solid")
    (uploads / "part.step").write_text("solid")
    assert upload_source("part.step") == ((uploads / "part.step").resolve(), b"solid")
    assert upload_source(str(uploads / "sub" / "part.step")) == ((uploads / "sub" / "part.step").resolve(), b"solid")


@pytest.mark.parametrize("name", ["outside", "escape", "symlink", "dotfile", "dotdir", "directory", "bridge", "hardlink", "hardlinked_original"])
def test_upload_outside_uploads_or_hidden_is_refused(uploads, name):
    uploads.mkdir(parents=True)
    (uploads / ".hidden").mkdir()
    (uploads / ".hidden" / "a.step").write_text("x")
    (uploads / ".env").write_text("x")
    (uploads / "dir").mkdir()
    os.symlink(uploads.parent.parent / "outside.step", uploads / "link.step")
    # A hard link to a secret elsewhere has no symlink to resolve; refuse any multiply-linked file.
    os.link(uploads.parent.parent / "outside.step", uploads / "hard.step")
    (uploads / "original.step").write_text("x")
    os.link(uploads / "original.step", uploads / "dir" / "copy.step")
    path = {"outside": str(uploads.parent.parent / "outside.step"), "escape": "../../outside.step", "symlink": "link.step",
            "dotfile": ".env", "dotdir": ".hidden/a.step", "directory": "dir", "bridge": "../bridge.json",
            "hardlink": "hard.step", "hardlinked_original": "original.step"}[name]
    with pytest.raises(OnshapeError, match=str(uploads.resolve())):
        upload_source(path)


async def test_api_upload_sends_bytes_read_from_the_checked_file(uploads, monkeypatch):
    import base64
    from onshape_native import server
    uploads.mkdir(parents=True)
    (uploads / "part.step").write_bytes(b"\x00solid")
    sent = []
    class Client:
        async def command(self, job): sent.append(job); return {"status": 200, "body": {}}
    class Catalog:
        def schema(self, operation): return {"requestBody": {"content": {"multipart/form-data": {}}}}
        def resolve(self, operation, path, query): return "POST", "/api/v6/blobelements/d/" + "a" * 24 + "/w/" + "b" * 24
    class Store:
        def response(self, data): return data
    class Service: client = Client(); catalog = Catalog(); store = Store()
    monkeypatch.setattr(server, "svc", lambda: Service())
    await server.api_upload("uploadFileCreateElement", [{"field": "file", "path": "part.step"}])
    assert b"\x00solid" in base64.b64decode(sent[0]["body_base64"]) and sent[0]["content_type"].startswith("multipart/form-data")
