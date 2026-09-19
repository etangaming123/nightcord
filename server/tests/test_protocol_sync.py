"""PROTOCOL.md, server protocol.py and client protocol.js must agree."""

import re
from pathlib import Path

from nightcord import protocol as P
from nightcord.handlers import load_all

ROOT = Path(__file__).resolve().parents[2]
SPEC = (ROOT / "docs" / "PROTOCOL.md").read_text()
CLIENT = (ROOT / "client" / "js" / "protocol.js").read_text()


def _spec_types() -> dict[str, str]:
    """{type: direction} from every `| \\`type\\` | C→S/S→C | ... |` table row."""
    rows = re.findall(r"^\| `([a-z_.]+)` \| (C→S|S→C) \|", SPEC, re.M)
    return dict(rows)


def _server_types() -> set[str]:
    return {
        v for k, v in vars(P).items()
        if k.isupper() and isinstance(v, str) and "." in v and k != "PROTOCOL_VERSION"
    }


def _client_block(name: str) -> str:
    m = re.search(rf"export const {name} = Object\.freeze\(\{{(.*?)\}}\);", CLIENT, re.S)
    assert m, name
    return m.group(1)


def test_spec_types_match_server():
    assert set(_spec_types()) == _server_types()


def test_spec_types_match_client():
    client = set(re.findall(r':\s*"([a-z_]+\.[a-z_.]+)"', _client_block("T")))
    assert client == set(_spec_types())


def test_every_request_type_has_a_handler():
    requests = {t for t, d in _spec_types().items() if d == "C→S"}
    assert requests == set(load_all())


def test_error_codes_match():
    spec_section = SPEC.split("## 9. Errors", 1)[1].split("\n## ", 1)[0]
    spec_codes = set(re.findall(r"`([a-z_]+)`", spec_section)) - {"code", "message"}
    assert spec_codes == set(P.ERROR_CODES)
    client_codes = set(re.findall(r':\s*"([a-z_]+)"', _client_block("ERR"))) - {"disconnected", "timeout"}
    assert client_codes == set(P.ERROR_CODES)


def test_version_matches():
    assert f"Version: `{P.PROTOCOL_VERSION}`" in SPEC
    assert f'PROTOCOL_VERSION = "{P.PROTOCOL_VERSION}"' in CLIENT
