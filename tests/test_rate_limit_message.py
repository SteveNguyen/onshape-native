import asyncio

import pytest

from onshape_native.client import Client, OnshapeError, Settings


def client_with(reply):
    c = Client(Settings.load())

    async def command(job):
        return reply
    c.command = command
    return c


def test_429_says_which_endpoint_and_how_long_to_wait_and_not_to_retry():
    c = client_with({"status": 429, "body": {"message": "Too many requests."}, "response_headers": {"retry-after": "84357"}})
    with pytest.raises(OnshapeError) as error:
        asyncio.run(c.request("GET", "/api/v10/partstudios/d/x/w/y/e/z/features"))
    message = str(error.value)
    assert "HTTP 429" in message and "/api/v10/partstudios/d/x/w/y/e/z/features" in message
    assert "23.4 h" in message and "Do not retry" in message


def test_other_errors_keep_the_generic_message():
    c = client_with({"status": 404, "body": {}})
    with pytest.raises(OnshapeError, match="Onshape browser HTTP 404"):
        asyncio.run(c.request("GET", "/api/v10/x"))
