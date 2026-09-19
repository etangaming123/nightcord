"""Wire-format constants and helpers.

Implemented directly against docs/PROTOCOL.md. If this file and the spec
disagree, the spec wins. tests/test_protocol_sync.py enforces that the type
names here match the spec tables and client/js/protocol.js.
"""

from __future__ import annotations

import re
from typing import Any

PROTOCOL_VERSION = "0.2"

# --- Message types -----------------------------------------------------------

# Auth
AUTH_REGISTER = "auth.register"
AUTH_LOGIN = "auth.login"
AUTH_RESUME = "auth.resume"
AUTH_REQUEST_ACCOUNT = "auth.request_account"
AUTH_REQUEST_ACCOUNT_RESULT = "auth.request_account.result"
AUTH_OK = "auth.ok"
AUTH_ERROR = "auth.error"
AUTH_LOGOUT = "auth.logout"
AUTH_LOGOUT_RESULT = "auth.logout.result"

# Server info / config
SERVER_INFO = "server.info"
SERVER_INFO_RESULT = "server.info.result"
SERVER_CONFIG_UPDATE = "server.config.update"
SERVER_CONFIG_UPDATE_RESULT = "server.config.update.result"

# Guilds
GUILD_LIST = "guild.list"
GUILD_LIST_RESULT = "guild.list.result"
GUILD_CREATE = "guild.create"
GUILD_CREATE_RESULT = "guild.create.result"
GUILD_PUBLIC_LIST = "guild.public_list"
GUILD_PUBLIC_LIST_RESULT = "guild.public_list.result"
GUILD_JOIN_BY_CODE = "guild.join_by_code"
GUILD_JOIN_BY_CODE_RESULT = "guild.join_by_code.result"
GUILD_JOIN_BY_ID = "guild.join_by_id"
GUILD_JOIN_BY_ID_RESULT = "guild.join_by_id.result"
GUILD_OWNER_OVERRIDE_JOIN = "guild.owner_override_join"
GUILD_OWNER_OVERRIDE_JOIN_RESULT = "guild.owner_override_join.result"
GUILD_LEAVE = "guild.leave"
GUILD_LEAVE_RESULT = "guild.leave.result"
GUILD_MEMBERS = "guild.members"
GUILD_MEMBERS_RESULT = "guild.members.result"
GUILD_CONFIG_UPDATE = "guild.config.update"
GUILD_CONFIG_UPDATE_RESULT = "guild.config.update.result"
GUILD_INVITE_CREATE = "guild.invite.create"
GUILD_INVITE_CREATE_RESULT = "guild.invite.create.result"
GUILD_UPDATED = "guild.updated"
GUILD_MEMBER_JOINED = "guild.member_joined"
GUILD_MEMBER_LEFT = "guild.member_left"

# Channels
CHANNEL_LIST = "channel.list"
CHANNEL_LIST_RESULT = "channel.list.result"
CHANNEL_JOIN = "channel.join"
CHANNEL_JOIN_RESULT = "channel.join.result"
CHANNEL_LEAVE = "channel.leave"
CHANNEL_LEAVE_RESULT = "channel.leave.result"
CHANNEL_HISTORY = "channel.history"
CHANNEL_HISTORY_RESULT = "channel.history.result"
CHANNEL_CREATE = "channel.create"
CHANNEL_CREATE_RESULT = "channel.create.result"
CHANNEL_UPDATE = "channel.update"
CHANNEL_UPDATE_RESULT = "channel.update.result"
CHANNEL_DELETE = "channel.delete"
CHANNEL_DELETE_RESULT = "channel.delete.result"
CHANNEL_CREATED = "channel.created"
CHANNEL_UPDATED = "channel.updated"
CHANNEL_DELETED = "channel.deleted"

# Messaging
MESSAGE_SEND = "message.send"
MESSAGE_SEND_RESULT = "message.send.result"
MESSAGE_NEW = "message.new"

# Presence
PRESENCE_LIST = "presence.list"
PRESENCE_LIST_RESULT = "presence.list.result"
PRESENCE_UPDATE = "presence.update"

# Generic error for frames that can't be attributed to a request type
ERROR = "error"

# Types a client may send before authenticating.
PRE_AUTH_TYPES = frozenset(
    {SERVER_INFO, AUTH_REGISTER, AUTH_LOGIN, AUTH_RESUME, AUTH_REQUEST_ACCOUNT}
)

# Requests answered with auth.ok / auth.error instead of X.result / X.error.
AUTH_OK_TYPES = frozenset({AUTH_REGISTER, AUTH_LOGIN, AUTH_RESUME})

# --- Error codes -------------------------------------------------------------

INVALID_CREDENTIALS = "invalid_credentials"
SESSION_EXPIRED = "session_expired"
REGISTRATION_CLOSED = "registration_closed"
REGISTRATION_PENDING_APPROVAL = "registration_pending_approval"
INVITE_INVALID = "invite_invalid"
NOT_FOUND = "not_found"
FORBIDDEN = "forbidden"
BAD_REQUEST = "bad_request"
UNKNOWN_TYPE = "unknown_type"
NOT_AUTHENTICATED = "not_authenticated"
USERNAME_TAKEN = "username_taken"
INVALID_USERNAME = "invalid_username"
INVALID_PASSWORD = "invalid_password"
CONTENT_TOO_LONG = "content_too_long"
RATE_LIMITED = "rate_limited"
GUILD_CREATION_DISABLED = "guild_creation_disabled"
ALREADY_MEMBER = "already_member"
INTERNAL_ERROR = "internal_error"

ERROR_CODES = frozenset(
    {
        INVALID_CREDENTIALS, SESSION_EXPIRED, REGISTRATION_CLOSED,
        REGISTRATION_PENDING_APPROVAL, INVITE_INVALID, NOT_FOUND, FORBIDDEN,
        BAD_REQUEST, UNKNOWN_TYPE, NOT_AUTHENTICATED, USERNAME_TAKEN,
        INVALID_USERNAME, INVALID_PASSWORD, CONTENT_TOO_LONG, RATE_LIMITED,
        GUILD_CREATION_DISABLED, ALREADY_MEMBER, INTERNAL_ERROR,
    }
)

# --- Limits ------------------------------------------------------------------

MAX_FRAME_BYTES = 64 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN_BYTES = 8
PASSWORD_MAX_BYTES = 72
CONTENT_MAX_CHARS = 2000
GUILD_NAME_MAX = 100
CHANNEL_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 100
RESERVED_USERNAMES = frozenset({"owner"})


class ProtocolError(Exception):
    """Raised by handlers; becomes an `X.error` (or `auth.error`) frame."""

    def __init__(self, code: str, message: str | None = None):
        assert code in ERROR_CODES, code
        super().__init__(message or code)
        self.code = code
        self.message = message or code.replace("_", " ")


# --- Envelope builders -------------------------------------------------------


def frame(type_: str, payload: dict[str, Any] | None = None, id_: Any = None) -> dict:
    out: dict[str, Any] = {"type": type_, "payload": payload if payload is not None else {}}
    if id_ is not None:
        out["id"] = id_
    return out


def result_type(request_type: str) -> str:
    return AUTH_OK if request_type in AUTH_OK_TYPES else f"{request_type}.result"


def error_type(request_type: str) -> str:
    return AUTH_ERROR if request_type in AUTH_OK_TYPES else f"{request_type}.error"


def error_payload(code: str, message: str) -> dict:
    return {"code": code, "message": message}


# --- Payload field helpers ---------------------------------------------------


def req_str(payload: dict, key: str, *, max_len: int | None = None) -> str:
    val = payload.get(key)
    if not isinstance(val, str) or not val:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be a non-empty string")
    if max_len is not None and len(val) > max_len:
        raise ProtocolError(BAD_REQUEST, f"'{key}' is too long")
    return val


def opt_str(payload: dict, key: str) -> str | None:
    val = payload.get(key)
    if val is None:
        return None
    if not isinstance(val, str):
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be a string")
    return val


def opt_bool(payload: dict, key: str) -> bool | None:
    val = payload.get(key)
    if val is None:
        return None
    if not isinstance(val, bool):
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be a boolean")
    return val


def opt_int(payload: dict, key: str) -> int | None:
    val = payload.get(key)
    if val is None:
        return None
    if not isinstance(val, int) or isinstance(val, bool):
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be an integer")
    return val


def validate_username(username: Any) -> str:
    if not isinstance(username, str) or not USERNAME_RE.match(username):
        raise ProtocolError(
            INVALID_USERNAME, "Username must be 3-32 characters: letters, digits, _ . -"
        )
    return username


def validate_password(password: Any) -> str:
    if not isinstance(password, str):
        raise ProtocolError(INVALID_PASSWORD, "Password must be a string")
    n = len(password.encode("utf-8"))
    if n < PASSWORD_MIN_BYTES or n > PASSWORD_MAX_BYTES:
        raise ProtocolError(INVALID_PASSWORD, "Password must be 8-72 bytes")
    return password


def validate_guild_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ProtocolError(BAD_REQUEST, "Guild name must be non-empty")
    name = name.strip()
    if len(name) > GUILD_NAME_MAX:
        raise ProtocolError(BAD_REQUEST, "Guild name must be at most 100 characters")
    return name


def validate_channel_name(name: Any) -> str:
    if not isinstance(name, str) or not CHANNEL_NAME_RE.match(name):
        raise ProtocolError(
            BAD_REQUEST, "Channel name must be 1-32 characters: a-z, 0-9, _ -"
        )
    return name


def validate_content(content: Any) -> str:
    if not isinstance(content, str):
        raise ProtocolError(BAD_REQUEST, "'content' must be a string")
    content = content.strip()
    if not content:
        raise ProtocolError(BAD_REQUEST, "Message is empty")
    if len(content) > CONTENT_MAX_CHARS:
        raise ProtocolError(CONTENT_TOO_LONG, "Message exceeds 2000 characters")
    return content
