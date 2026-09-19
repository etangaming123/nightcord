#!/usr/bin/env python3
"""Nightcord server entry point and admin CLI.

    python nightcord_server.py [run] [--config nightcord.toml] [--port N] [--no-tls]
    python nightcord_server.py pending list
    python nightcord_server.py pending approve|reject <username>
    python nightcord_server.py users list [--status active|pending|rejected|disabled]
    python nightcord_server.py users disable|enable <username>
    python nightcord_server.py owner reset-password
    python nightcord_server.py config show
    python nightcord_server.py config set <key> <value>
    python nightcord_server.py guilds

Admin commands operate on the same SQLite database and are safe to run
while the server is up. Most of them are also in the client's Admin panel.
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


def _new_password() -> str:
    return secrets.token_urlsafe(18)


def _banner(*lines: str) -> None:
    bar = "=" * 64
    print(bar)
    for line in lines:
        print(f"  {line}")
    print(bar, flush=True)


def cmd_run(cfg: Config) -> None:
    from aiohttp import web

    from nightcord.app import create_app, new_setup_code

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    db = Database(cfg.db_path)
    db.purge_expired_sessions()
    setup_code = None
    if db.get_server_owner_row() is None:
        setup_code = new_setup_code()
        _banner(
            "This server has no owner yet.",
            f"Setup code: {setup_code}",
            "Connect with the Nightcord client and enter this code to create",
            "the server-owner account. A new code is printed on every start",
            "until setup is done.",
        )
    ssl_ctx = None
    if cfg.tls:
        from nightcord.tls import ensure_ssl_context

        hostnames = [cfg.host, *cfg.public_hostnames]
        ssl_ctx = ensure_ssl_context(cfg.cert_path, cfg.key_path, hostnames)
    scheme = "wss" if ssl_ctx else "ws"
    name = db.get_server_config()["server_name"] or cfg.server_name
    print(f"[nightcord] '{name}' listening on {scheme}://{cfg.host}:{cfg.port}/ws", flush=True)
    print(f"[nightcord] allowed origins: {', '.join(cfg.allowed_origins)}", flush=True)
    web.run_app(
        create_app(cfg, db, setup_code=setup_code), host=cfg.host, port=cfg.port, ssl_context=ssl_ctx, print=None
    )


def _user_row(db: Database, username: str | None):
    if not username:
        print("username required", file=sys.stderr)
        return None
    row = db.get_user_row_by_name(username)
    if row is None:
        print(f"No user named '{username}'.", file=sys.stderr)
    return row


def cmd_pending(db: Database, action: str, username: str | None) -> int:
    if action == "list":
        rows = db.list_users(status="pending")
        if not rows:
            print("No pending account requests.")
        for r in rows:
            note = f"  — {r['note']}" if r["note"] else ""
            print(f"{r['username']}  (requested {r['created_at']}){note}")
        return 0
    row = _user_row(db, username)
    if row is None:
        return 2 if not username else 1
    if row["status"] != "pending":
        print(f"No pending request for '{username}'.", file=sys.stderr)
        return 1
    db.set_user_status(row["user_id"], "active" if action == "approve" else "rejected")
    print(f"{action.capitalize()}d '{row['username']}'.")
    return 0


def cmd_users(db: Database, action: str, username: str | None, status: str | None) -> int:
    if action == "list":
        rows = db.list_users(status=status, limit=10_000)
        if not rows:
            print("No users.")
        for r in rows:
            owner = " [server owner]" if r["is_server_owner"] else ""
            print(f"{r['user_id']}  {r['username']}  ({r['status']}, since {r['created_at']}){owner}")
        return 0
    row = _user_row(db, username)
    if row is None:
        return 2 if not username else 1
    if row["is_server_owner"]:
        print("The server owner can't be disabled.", file=sys.stderr)
        return 1
    want, need = ("disabled", "active") if action == "disable" else ("active", "disabled")
    if row["status"] != need:
        print(f"'{row['username']}' is {row['status']}, not {need}.", file=sys.stderr)
        return 1
    db.set_user_status(row["user_id"], want)
    note = " Open connections stay up until they reconnect; the client's Admin panel disconnects them at once." if want == "disabled" else ""
    print(f"{row['username']} is now {want}.{note}")
    return 0


def cmd_owner_reset(db: Database) -> int:
    row = db.get_server_owner_row()
    if row is None:
        print("This server has no owner yet. Start it and use the setup code it prints.", file=sys.stderr)
        return 1
    password = _new_password()
    db.set_password_hash(row["user_id"], hash_password_sync(password))
    _banner(
        "Server-owner account",
        f"  username: {row['username']}",
        f"  password: {password}",
        "Shown once. Change it in the client under User Settings → My Account.",
    )
    return 0


def cmd_config(db: Database, cfg: Config, action: str, key: str | None, value: str | None) -> int:
    if action == "show":
        for k, v in db.get_server_config().items():
            if k == "server_name" and v is None:
                v = f"{cfg.server_name} (from config file)"
            print(f"{k} = {v}")
        return 0
    allowed = {
        "guild_creation": {"off", "on"},
        "account_creation": {"off", "request", "on"},
        "guild_list_visible": {"true", "false"},
    }
    if key == "server_name" and value and value.strip():
        db.set_server_config({"server_name": value.strip()[:64]})
        print(f"server_name = {value.strip()[:64]}")
        return 0
    if key not in allowed or value not in allowed[key]:
        print(f"Usage: config set <key> <value>; keys: server_name, {allowed}", file=sys.stderr)
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
        owner = r["owner"]["username"] if r["owner"] else "?"
        print(f"{r['guild_id']}  {r['name']}  (owner: {owner}, {r['member_count']} members){flags}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Nightcord server")
    p.add_argument("--config", type=Path, help="path to nightcord.toml")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.add_argument("--data-dir", type=Path)
    p.add_argument("--name", help="server name shown to clients until the owner sets one")
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
    users = sub.add_parser("users", help="list, disable or re-enable accounts")
    users.add_argument("action", choices=["list", "disable", "enable"])
    users.add_argument("username", nargs="?")
    users.add_argument("--status", choices=["active", "pending", "rejected", "disabled"])
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
        if args.command == "users":
            return cmd_users(db, args.action, args.username, args.status)
        if args.command == "owner":
            return cmd_owner_reset(db)
        if args.command == "config":
            return cmd_config(db, cfg, args.action, args.key, args.value)
        if args.command == "guilds":
            return cmd_guilds(db)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
