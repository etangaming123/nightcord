"""auth.* handlers (PROTOCOL.md §3, §5 Auth, §8)."""

from __future__ import annotations

import asyncio
import collections
import time

import bcrypt

from .. import protocol as P
from ..protocol import ProtocolError
from . import handles

LOGIN_ATTEMPTS = 10
LOGIN_WINDOW = 60.0

# Compared against when the username doesn't exist, so response time doesn't
# reveal whether an account exists.
_DUMMY_HASH = bcrypt.hashpw(b"nightcord-dummy-password", bcrypt.gensalt()).decode()


class LoginThrottle:
    """Per-IP cap on auth attempts: failed logins, and every register/request."""

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


async def _login_success(ctx, conn, user: dict) -> dict:
    token = ctx.db.create_session(user["user_id"])
    conn.session_token = token
    await ctx.hub.authenticated(conn, user)
    return {"session_token": token, "user": user}


def _check_new_username(ctx, username) -> str:
    username = P.validate_username(username)
    if username.lower() in P.RESERVED_USERNAMES or ctx.db.get_user_row_by_name(username):
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    return username


@handles(P.AUTH_REGISTER)
async def register(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote)
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
    user = ctx.db.create_user(username, await hash_password(password))
    if user is None:  # lost a race with a concurrent registration
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    return await _login_success(ctx, conn, user)


@handles(P.AUTH_REQUEST_ACCOUNT)
async def request_account(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote)
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
    user = ctx.db.create_user(username, await hash_password(password), status="pending", note=note)
    if user is None:
        raise ProtocolError(P.USERNAME_TAKEN, "That username is taken")
    return {"status": "pending"}


@handles(P.AUTH_LOGIN)
async def login(ctx, conn, payload):
    ctx.login_throttle.check(conn.remote, record=False)
    username = payload.get("username")
    password = payload.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ProtocolError(P.BAD_REQUEST, "username and password are required")
    row = ctx.db.get_user_row_by_name(username)
    ok = await check_password(password, row["password_hash"] if row else _DUMMY_HASH)
    if row is None or not ok or row["status"] == "rejected":
        ctx.login_throttle.record(conn.remote)
        raise ProtocolError(P.INVALID_CREDENTIALS, "Wrong username or password")
    if row["status"] == "pending":
        raise ProtocolError(
            P.REGISTRATION_PENDING_APPROVAL, "Your account is waiting for the server owner's approval"
        )
    return await _login_success(ctx, conn, ctx.db.get_user(row["user_id"]))


@handles(P.AUTH_RESUME)
async def resume(ctx, conn, payload):
    token = P.req_str(payload, "session_token", max_len=256)
    user_id = ctx.db.resume_session(token)
    user = ctx.db.get_user(user_id) if user_id else None
    row = ctx.db.get_user_row(user_id) if user_id else None
    if user is None or row["status"] != "active":
        raise ProtocolError(P.SESSION_EXPIRED, "Session expired; please log in again")
    conn.session_token = token
    await ctx.hub.authenticated(conn, user)
    return {"session_token": token, "user": user}


@handles(P.AUTH_LOGOUT)
async def logout(ctx, conn, payload):
    if conn.session_token:
        ctx.db.delete_session(conn.session_token)
    await ctx.hub.deauthenticate(conn)
    return {}
