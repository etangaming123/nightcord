"""Self-signed certificate generation (v1 TLS strategy, PROTOCOL.md §10)."""

from __future__ import annotations

import datetime as dt
import ipaddress
import os
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def _san_entries(hostnames: list[str]) -> list[x509.GeneralName]:
    names: list[x509.GeneralName] = []
    seen: set[str] = set()
    for h in ["localhost", "127.0.0.1", "::1", *hostnames]:
        if not h or h in seen or h in ("0.0.0.0", "::"):
            continue
        seen.add(h)
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            names.append(x509.DNSName(h))
    return names


def generate_self_signed(cert_path: Path, key_path: Path, hostnames: list[str]) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Nightcord self-signed")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        # Browsers reject leaf certs valid > 398 days, even self-signed ones in some cases.
        .not_valid_after(now + dt.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(_san_entries(hostnames)), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    os.chmod(key_path, 0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def ensure_ssl_context(cert_path: Path, key_path: Path, hostnames: list[str]) -> ssl.SSLContext:
    if not cert_path.exists() or not key_path.exists():
        generate_self_signed(cert_path, key_path, hostnames)
        print(f"[nightcord] Generated self-signed certificate at {cert_path}")
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(cert_path, key_path)
    return ctx
