"""Server configuration: optional TOML file, overridden by CLI flags.

Example nightcord.toml:

    server_name = "My Nightcord"
    host = "0.0.0.0"
    port = 8765
    data_dir = "data"
    tls = true
    public_hostnames = ["chat.example.com", "203.0.113.7"]
    allowed_origins = ["https://you.github.io"]
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ORIGINS = [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]


@dataclass
class Config:
    server_name: str = "Nightcord"
    host: str = "0.0.0.0"
    port: int = 8765
    data_dir: Path = Path("data")
    tls: bool = True
    cert_file: Path | None = None
    key_file: Path | None = None
    # Extra DNS names / IPs to put in the generated self-signed cert.
    public_hostnames: list[str] = field(default_factory=list)
    # Browser Origins allowed to open /ws. "*" allows any origin.
    allowed_origins: list[str] = field(default_factory=lambda: list(DEFAULT_ORIGINS))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "nightcord.db"

    @property
    def cert_path(self) -> Path:
        return self.cert_file or self.data_dir / "cert.pem"

    @property
    def key_path(self) -> Path:
        return self.key_file or self.data_dir / "key.pem"

    def origin_allowed(self, origin: str | None) -> bool:
        if "*" in self.allowed_origins:
            return True
        # Non-browser clients (tests, CLI tools) send no Origin header.
        if origin is None:
            return True
        return origin.rstrip("/") in {o.rstrip("/") for o in self.allowed_origins}


def load_config(path: Path | None) -> Config:
    cfg = Config()
    if path is None:
        return cfg
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    base = path.parent
    for key, val in raw.items():
        if not hasattr(cfg, key):
            raise ValueError(f"Unknown config key: {key}")
        if key in ("data_dir", "cert_file", "key_file") and val is not None:
            val = (base / val) if not Path(val).is_absolute() else Path(val)
        setattr(cfg, key, val)
    return cfg
