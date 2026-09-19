#!/usr/bin/env python3
"""Nightcord server entry point and admin CLI.

    python nightcord_server.py [run] [--config nightcord.toml] [--port N] [--no-tls]
    python nightcord_server.py pending list
    python nightcord_server.py pending approve <username>
    python nightcord_server.py pending reject <username>
    python nightcord_server.py owner reset-password
    python nightcord_server.py config show
    python nightcord_server.py config set <key> <value>
    python nightcord_server.py guilds

Admin commands operate on the same SQLite database and are safe to run
while the server is up.
"""

from __future__ import annotations

import argparse
import logging
import secrets
import sys
from pathlib import Path

from nightcord.config import Config, load_config
from nightcord.db import Database
from nightcord.handlers.auth import hash_password_sync

OWNER_USERNAME = "owner"


def _new_password() -> str:
    return secrets.token_urlsafe(18)


def _print_owner_credentials(password: str) -> None:
    bar = "=" * 60
    print(bar)
    print("  Server-owner account")
    print(f"    username: {OWNER_USERNAME}")
    print(f"    password: {password}")
    print("  This is shown ONCE. Reset with: nightcord_server.py owner reset-password")
    print(bar, flush=True)


def ensure_owner(db: Database) -> None:
    if db.get_server_owner_row() is not None:
        return
    password = _new_password()
    db.create_user(OWNER_USERNAME, hash_password_sync(password), is_server_owner=True)
    _print_owner_credentials(password)


def cmd_run(cfg: Config) -> None:
    from aiohttp import web

    from nightcord.app import create_app

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    db = Database(cfg.db_path)
    ensure_owner(db)
    db.purge_expired_sessions()
    ssl_ctx = None
    if cfg.tls:
        from nightcord.tls import ensure_ssl_context

        hostnames = [cfg.host, *cfg.public_hostnames]
        ssl_ctx = ensure_ssl_context(cfg.cert_path, cfg.key_path, hostnames)
    scheme = "wss" if ssl_ctx else "ws"
    print(f"[nightcord] '{cfg.server_name}' listening on {scheme}://{cfg.host}:{cfg.port}/ws", flush=True)
    print(f"[nightcord] allowed origins: {', '.join(cfg.allowed_origins)}", flush=True)
    web.run_app(create_app(cfg, db), host=cfg.host, port=cfg.port, ssl_context=ssl_ctx, print=None)


def cmd_pending(db: Database, action: str, username: str | None) -> int:
    if action == "list":
        rows = db.list_users_by_status("pending")
        if not rows:
            print("No pending account requests.")
        for r in rows:
            note = f"  — {r['note']}" if r["note"] else ""
            print(f"{r['username']}  (requested {r['created_at']}){note}")
        return 0
    if not username:
        print("username required", file=sys.stderr)
        return 2
    row = db.get_user_row_by_name(username)
    if row is None or row["status"] != "pending":
        print(f"No pending request for '{username}'.", file=sys.stderr)
        return 1
    db.set_user_status(username, "active" if action == "approve" else "rejected")
    print(f"{action.capitalize()}d '{row['username']}'.")
    return 0


def cmd_owner_reset(db: Database) -> int:
    row = db.get_server_owner_row()
    password = _new_password()
    if row is None:
        db.create_user(OWNER_USERNAME, hash_password_sync(password), is_server_owner=True)
    else:
        db.set_password_hash(row["user_id"], hash_password_sync(password))
    _print_owner_credentials(password)
    return 0


def cmd_config(db: Database, action: str, key: str | None, value: str | None) -> int:
    if action == "show":
        for k, v in db.get_server_config().items():
            print(f"{k} = {v}")
        return 0
    allowed = {
        "guild_creation": {"off", "on"},
        "account_creation": {"off", "request", "on"},
        "guild_list_visible": {"true", "false"},
    }
    if key not in allowed or value not in allowed[key]:
        print(f"Usage: config set <key> <value>; keys: {allowed}", file=sys.stderr)
        return 2
    parsed = (value == "true") if key == "guild_list_visible" else value
    db.set_server_config({key: parsed})
    print(f"{key} = {parsed}")
    return 0


def cmd_guilds(db: Database) -> int:
    rows = db.admin_list_guilds()
    if not rows:
        print("No guilds yet.")
    for r in rows:
        flags = " [listed]" if r["listed"] else ""
        print(f"{r['guild_id']}  {r['name']}  (owner: {r['owner']}, {r['members']} members){flags}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Nightcord server")
    p.add_argument("--config", type=Path, help="path to nightcord.toml")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.add_argument("--data-dir", type=Path)
    p.add_argument("--name", help="server name shown to clients")
    p.add_argument("--no-tls", action="store_true", help="serve plain ws:// (local dev / behind a TLS proxy)")
    p.add_argument(
        "--allow-origin", action="append", default=None,
        help="browser Origin allowed to connect (repeatable; '*' for any)",
    )
    sub = p.add_subparsers(dest="command")
    sub.add_parser("run", help="run the server (default)")
    pend = sub.add_parser("pending", help="review account requests")
    pend.add_argument("action", choices=["list", "approve", "reject"])
    pend.add_argument("username", nargs="?")
    own = sub.add_parser("owner", help="server-owner account")
    own.add_argument("action", choices=["reset-password"])
    conf = sub.add_parser("config", help="server-wide settings")
    conf.add_argument("action", choices=["show", "set"])
    conf.add_argument("key", nargs="?")
    conf.add_argument("value", nargs="?")
    sub.add_parser("guilds", help="list every guild with its ID (for ghost joins)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    if args.host:
        cfg.host = args.host
    if args.port:
        cfg.port = args.port
    if args.data_dir:
        cfg.data_dir = args.data_dir
    if args.name:
        cfg.server_name = args.name
    if args.no_tls:
        cfg.tls = False
    if args.allow_origin:
        cfg.allowed_origins = [*cfg.allowed_origins, *args.allow_origin]

    if args.command in (None, "run"):
        cmd_run(cfg)
        return 0
    db = Database(cfg.db_path)
    try:
        if args.command == "pending":
            return cmd_pending(db, args.action, args.username)
        if args.command == "owner":
            return cmd_owner_reset(db)
        if args.command == "config":
            return cmd_config(db, args.action, args.key, args.value)
        if args.command == "guilds":
            return cmd_guilds(db)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
