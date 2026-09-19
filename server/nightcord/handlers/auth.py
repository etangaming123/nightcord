"""auth.* and setup.claim handlers (PROTOCOL.md §3, §5 Auth, §8, §8a)."""

from __future__ import annotations

import asyncio
import collections
import hashlib
import hmac
import re
import time

import bcrypt

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles
from .legal import legal_version, require_accepted
from .server import apply_config_updates

LOGIN_ATTEMPTS = 10
LOGIN_WINDOW = 60.0

# Compared against when the username doesn't exist, so response time doesn't
# reveal whether an account exists.
_DUMMY_HASH = bcrypt.hashpw(b"nightcord-dummy-password", bcrypt.gensalt()).decode()


class LoginThrottle:
    """Per-IP cap on auth attempts: failed logins, and every register/request/claim."""

    def __init__(self, attempts: int = LOGIN_ATTEMPTS, window: float = LOGIN_WINDOW):
        self.attempts = attempts
        self.window = window
        self._hits: dict[str, collections.deque[float]] = collections.defaultdict(collections.deque)

    def check(self, key: str, *, record: bool = True) -> None:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.attempts:
            raise ProtocolError(P.RATE_LIMITED, "Too many attempts; wait a minute")
        if record:
            q.append(now)

    def record(self, key: str) -> None:
        self._hits[key].append(time.monotonic())


async def hash_password(password: str) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    )


async def check_password(password: str, password_hash: str) -> bool:
    # bcrypt>=5 raises on inputs over 72 bytes; such passwords can never have
    # been registered (validate_password), so just fail them after the same work.
    raw = password.encode()
    too_long = len(raw) > P.PASSWORD_MAX_BYTES
    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(
        None, lambda: bcrypt.checkpw(raw[: P.PASSWORD_MAX_BYTES], password_hash.encode())
    )
    return ok and not too_long


def hash_password_sync(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def hash_setup_code(code: str) -> str:
    # Dashes, spaces and case don't matter when typing the code.
    return hashlib.sha256(re.sub(r"[^A-Z0-9]", "", code.upper()).encode()).hexdigest()


def setup_required(ctx) -> bool:
    return ctx.db.get_server_owner_row() is None


def _require_setup_done(ctx) -> None:
    if setup_required(ctx):
        raise ProtocolError(P.SETUP_REQUIRED, "This server hasn't been set up yet")


def _device(ctx, conn, payload) -> str | None:
    device_id = P.opt_device_id(payload)
    if ctx.db.is_device_banned(device_id):
        raise ProtocolError(P.DEVICE_BANNED, "This device has been banned from this server")
    conn.device_id = device_id
    return device_id


def _auth_ok(ctx, token: str, user: dict) -> dict:
    version = legal_version(ctx)
    return {
        "session_token": token,
        "user": user,
        "legal_update_required": version is not None and user.get("legal_version") != version
        and not user["is_server_owner"],
    }


async def _login_success(ctx, conn, user: dict) -> dict:
    token = ctx.db.create_session(user["user_id"], conn.user_agent, ip=conn.remote, device_id=conn.device_id)
    conn.session_token = token
    await ctx.hub.authenticated(conn, user)
    return _auth_ok(ctx, token, user)


def _check_new_username(ctx, username) -> str:
    username = P.validate_username(username)
    if ctx.db.get_user_row_by_name(username):
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    return username


@handles(P.SETUP_CLAIM)
async def setup_claim(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote)
    _device(ctx, conn, payload)
    if not setup_required(ctx):
        raise ProtocolError(P.SETUP_ALREADY_DONE, "This server already has an owner")
    code = P.req_str(payload, "setup_code", max_len=64)
    if ctx.setup_code_hash is None or not hmac.compare_digest(hash_setup_code(code), ctx.setup_code_hash):
        raise ProtocolError(P.INVALID_SETUP_CODE, "That setup code is wrong; check the server console")
    username = _check_new_username(ctx, payload.get("username"))
    password = P.validate_password(payload.get("password"))
    config = {k: payload[k] for k in ("server_name", "account_creation", "guild_creation", "guild_list_visible") if k in payload}
    updates = apply_config_updates(ctx, config)
    user = ctx.db.create_user(username, await hash_password(password), is_server_owner=True)
    if user is None:
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    if updates:
        ctx.db.set_server_config(updates)
    ctx.setup_code_hash = None
    return await _login_success(ctx, conn, user)


@handles(P.AUTH_REGISTER)
async def register(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote)
    _require_setup_done(ctx)
    _device(ctx, conn, payload)
    policy = ctx.db.get_server_config()["account_creation"]
    if policy != "on":
        msg = (
            "This server requires an account request"
            if policy == "request"
            else "Registration is closed on this server"
        )
        raise ProtocolError(P.REGISTRATION_CLOSED, msg)
    username = _check_new_username(ctx, payload.get("username"))
    password = P.validate_password(payload.get("password"))
    version = require_accepted(ctx, payload)
    user = ctx.db.create_user(username, await hash_password(password))
    if user is None:  # lost a race with a concurrent registration
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    if version:
        user = ctx.db.update_profile(user["user_id"], {"legal_version": version})
    return await _login_success(ctx, conn, user)


@handles(P.AUTH_REQUEST_ACCOUNT)
async def request_account(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote)
    _require_setup_done(ctx)
    _device(ctx, conn, payload)
    policy = ctx.db.get_server_config()["account_creation"]
    if policy == "off":
        raise ProtocolError(P.REGISTRATION_CLOSED, "Registration is closed on this server")
    if policy == "on":
        raise ProtocolError(P.BAD_REQUEST, "Account requests aren't needed; register directly")
    username = _check_new_username(ctx, payload.get("username"))
    password = P.validate_password(payload.get("password"))
    note = P.opt_str(payload, "note")
    if note is not None:
        note = note.strip()[:500] or None
    version = require_accepted(ctx, payload)
    user = ctx.db.create_user(username, await hash_password(password), status="pending", note=note)
    if user is None:
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    if version:
        ctx.db.update_profile(user["user_id"], {"legal_version": version})
    await ctx.hub.send_to_staff(P.frame(P.ADMIN_ACCOUNT_REQUESTED, {"user": ctx.db.admin_user(user["user_id"])}))
    return {"status": "pending"}


@handles(P.AUTH_LOGIN)
async def login(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote, record=False)
    _require_setup_done(ctx)
    _device(ctx, conn, payload)
    username = payload.get("username")
    password = payload.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ProtocolError(P.BAD_REQUEST, "username and password are required")
    row = ctx.db.get_user_row_by_name(username)
    if row is not None and row["status"] == "deleted":
        row = None
    ok = await check_password(password, row["password_hash"] if row else _DUMMY_HASH)
    if row is None or not ok or row["status"] == "rejected":
        ctx.login_throttle.record(conn.remote)
        raise ProtocolError(P.INVALID_CREDENTIALS, "Wrong username or password")
    if row["status"] == "pending":
        raise ProtocolError(
            P.REGISTRATION_PENDING_APPROVAL, "Your account is waiting for the server owner's approval"
        )
    if row["status"] == "disabled":
        raise ProtocolError(P.ACCOUNT_DISABLED, "This account has been disabled by the server owner")
    return await _login_success(ctx, conn, ctx.db.get_user(row["user_id"]))


@handles(P.AUTH_RESUME)
async def resume(ctx, conn, payload):
    token = P.req_str(payload, "session_token", max_len=256)
    device_id = _device(ctx, conn, payload)
    user_id = ctx.db.resume_session(token, conn.user_agent)
    row = ctx.db.get_user_row(user_id) if user_id else None
    if row is None or row["status"] != "active":
        raise ProtocolError(P.SESSION_EXPIRED, "Session expired; please log in again")
    ctx.db.note_session(token, ip=conn.remote, device_id=device_id)
    user = ctx.db.get_user(user_id)
    conn.session_token = token
    await ctx.hub.authenticated(conn, user)
    return _auth_ok(ctx, token, user)


@handles(P.AUTH_LOGOUT)
async def logout(ctx, conn, payload):
    if conn.session_token:
        ctx.db.delete_session(conn.session_token)
    await ctx.hub.deauthenticate(conn)
    return {}
