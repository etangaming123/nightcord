#!/usr/bin/env python3
"""Nightcord server entry point and admin CLI.

    python nightcord_server.py [run] [--config nightcord.toml] [--port N] [--no-tls]
    python nightcord_server.py pending list
    python nightcord_server.py pending approve|reject <username>
    python nightcord_server.py users list [--status active|pending|rejected|disabled]
    python nightcord_server.py users disable|enable <username>
    python nightcord_server.py owner reset-password
    python nightcord_server.py staff list
    python nightcord_server.py staff set <username> admin|moderator|none
    python nightcord_server.py ipban list
    python nightcord_server.py ipban add|remove <ip-or-cidr>
    python nightcord_server.py perks list
    python nightcord_server.py perks add|remove <username>
    python nightcord_server.py config show
    python nightcord_server.py config set <key> <value>
    python nightcord_server.py guilds
    python nightcord_server.py backup [--out DIR]

Admin commands operate on the same SQLite database and are safe to run
while the server is up. Most of them are also in the client's Admin panel.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import secrets
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

from nightcord.config import Config, load_config
from nightcord.db import Database, snapshot_db
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
    db = Database(cfg.db_path, backup_dir=cfg.data_dir.parent / "backups")
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
        "voice_enabled": {"true", "false"},
        "customization_mode": {"off", "allowlist", "on"},
        "user_search": {"off", "staff", "on"},
        "announcements_admins": {"true", "false"},
        "link_embeds": {"true", "false"},
    }
    if key == "server_name" and value and value.strip():
        db.set_server_config({"server_name": value.strip()[:64]})
        print(f"server_name = {value.strip()[:64]}")
        return 0
    if key == "max_upload_mb" and value and value.isdigit() and 1 <= int(value) <= 1024:
        db.set_server_config({"max_upload_bytes": int(value) * 1024 * 1024})
        print(f"max_upload_bytes = {int(value) * 1024 * 1024}")
        return 0
    if key == "max_accounts_per_client" and value and value.isdigit() and int(value) <= 20:
        db.set_server_config({key: int(value)})
        print(f"{key} = {int(value)}")
        return 0
    if key not in allowed or value not in allowed[key]:
        print(
            "Usage: config set <key> <value>; keys: server_name, max_upload_mb (1-1024), "
            f"max_accounts_per_client (0-20, 0 = no limit), {allowed}",
            file=sys.stderr,
        )
        return 2
    parsed = (value == "true") if allowed[key] == {"true", "false"} else value
    db.set_server_config({key: parsed})
    print(f"{key} = {parsed}")
    return 0


# Folders under the data directory that a backup includes. TLS keys are left
# out on purpose: a restored server makes a fresh certificate.
BACKUP_DIRS = ("media", "files", "avatars", "legal")


def cmd_backup(cfg: Config, out_dir: Path | None) -> int:
    """Zips a consistent snapshot of the database plus uploads and the rules
    pages. Safe while the server is running (SQLite's online backup API)."""
    if not cfg.db_path.exists():
        print(f"No database at {cfg.db_path}", file=sys.stderr)
        return 1
    out_dir = out_dir or cfg.data_dir.parent / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    target = out_dir / f"nightcord-backup-{stamp}.zip"
    with tempfile.TemporaryDirectory() as tmp:
        snapshot = Path(tmp) / "nightcord.db"
        src = sqlite3.connect(str(cfg.db_path))
        try:
            snapshot_db(src, snapshot)
        finally:
            src.close()
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(snapshot, "nightcord.db")
            for name in BACKUP_DIRS:
                folder = cfg.data_dir / name
                if folder.is_dir():
                    for path in sorted(folder.rglob("*")):
                        if path.is_file():
                            zf.write(path, str(path.relative_to(cfg.data_dir)))
    print(f"Backup written to {target}")
    print("Restore: stop the server, unzip it into an empty data directory, start the server.")
    return 0


def cmd_staff(db: Database, action: str, username: str | None, role: str | None) -> int:
    if action == "list":
        found = False
        for r in db.list_users(limit=10_000):
            if r["server_role"] != "none":
                found = True
                print(f"{r['username']}  {r['server_role']}")
        if not found:
            print("No staff.")
        return 0
    row = _user_row(db, username)
    if row is None:
        return 2 if not username else 1
    if row["is_server_owner"]:
        print("The server owner's role can't change.", file=sys.stderr)
        return 1
    if role not in ("admin", "moderator", "none"):
        print("Usage: staff set <username> admin|moderator|none", file=sys.stderr)
        return 2
    db.update_profile(row["user_id"], {"server_role": role})
    print(f"{row['username']} is now {role}. Connected clients see it after reconnecting.")
    return 0


def cmd_ipban(db: Database, action: str, cidr: str | None) -> int:
    import ipaddress

    if action == "list":
        bans = db.ip_bans()
        if not bans:
            print("No IP bans.")
        for b in bans:
            reason = f"  — {b['reason']}" if b["reason"] else ""
            print(f"{b['cidr']}  (since {b['created_at']}){reason}")
        return 0
    try:
        net = str(ipaddress.ip_network((cidr or "").strip(), strict=False))
    except ValueError:
        print("Give an IP address or range, e.g. 203.0.113.7 or 203.0.113.0/24", file=sys.stderr)
        return 2
    if action == "add":
        owner = db.get_server_owner_row()
        db.add_ip_ban(net, None, owner["user_id"] if owner else "cli")
        print(f"Banned {net}. Open connections stay up until they reconnect.")
    elif db.remove_ip_ban(net):
        print(f"Unbanned {net}.")
    else:
        print(f"{net} isn't banned.", file=sys.stderr)
        return 1
    return 0


def cmd_perks(db: Database, action: str, username: str | None) -> int:
    if action == "list":
        users = db.perk_users()
        mode = db.get_server_config()["customization_mode"]
        print(f"customization_mode = {mode}" + ("" if mode == "allowlist" else " (the allow-list only matters in allowlist mode)"))
        if not users:
            print("Nobody has perks. Server staff always count as allowed.")
        for u in users:
            print(u["username"])
        return 0
    row = _user_row(db, username)
    if row is None:
        return 2 if not username else 1
    db.update_profile(row["user_id"], {"perks": action == "add"})
    print(f"{row['username']} {'now has' if action == 'add' else 'no longer has'} perks. Connected clients see it after reconnecting.")
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
    p.add_argument(
        "--allow-local-client", action="store_true",
        help="allow the standalone single-file HTML client, opened from disk (Origin: null)",
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
    staff = sub.add_parser("staff", help="server admins and moderators")
    staff.add_argument("action", choices=["list", "set"])
    staff.add_argument("username", nargs="?")
    staff.add_argument("role", nargs="?", choices=["admin", "moderator", "none"])
    ipban = sub.add_parser("ipban", help="server-wide IP bans")
    ipban.add_argument("action", choices=["list", "add", "remove"])
    ipban.add_argument("cidr", nargs="?")
    perks = sub.add_parser("perks", help="customisation allow-list")
    perks.add_argument("action", choices=["list", "add", "remove"])
    perks.add_argument("username", nargs="?")
    backup = sub.add_parser("backup", help="zip the database, uploads and rules pages")
    backup.add_argument("--out", type=Path, help="folder for the zip (default: backups/ next to the data folder)")
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
    if args.allow_local_client:
        cfg.allow_file_origin = True

    if args.command in (None, "run"):
        cmd_run(cfg)
        return 0
    if args.command == "backup":
        return cmd_backup(cfg, args.out)
    db = Database(cfg.db_path, backup_dir=cfg.data_dir.parent / "backups")
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
        if args.command == "staff":
            return cmd_staff(db, args.action, args.username, args.role)
        if args.command == "ipban":
            return cmd_ipban(db, args.action, args.cidr)
        if args.command == "perks":
            return cmd_perks(db, args.action, args.username)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
