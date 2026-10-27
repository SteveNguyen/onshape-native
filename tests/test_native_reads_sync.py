"""extension/policy.js keeps a copy of native_catalog.READS; the two must not drift."""
import re
from pathlib import Path

from onshape_native.native_catalog import READS

POLICY_JS = Path(__file__).resolve().parents[1] / "extension/policy.js"


def test_native_reads_match_policy_js():
    text = POLICY_JS.read_text()
    block = re.search(r"NATIVE_READS\s*=\s*new Set\(\[(.*?)\]\)", text, re.S).group(1)
    assert set(re.findall(r'"([^"]+)"', block)) == READS
