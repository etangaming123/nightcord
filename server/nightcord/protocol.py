"""Wire-format constants and helpers.

Implemented directly against docs/PROTOCOL.md. If this file and the spec
disagree, the spec wins. tests/test_protocol_sync.py enforces that the type
names here match the spec tables and client/js/protocol.js.
"""

from __future__ import annotations

import re
from typing import Any

PROTOCOL_VERSION = "0.3"

# --- Message types -----------------------------------------------------------

# Setup
SETUP_CLAIM = "setup.claim"

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

# Admin (server owner)
ADMIN_USERS_LIST = "admin.users.list"
ADMIN_USERS_LIST_RESULT = "admin.users.list.result"
ADMIN_USERS_SET_STATUS = "admin.users.set_status"
ADMIN_USERS_SET_STATUS_RESULT = "admin.users.set_status.result"
ADMIN_USERS_RESET_PASSWORD = "admin.users.reset_password"
ADMIN_USERS_RESET_PASSWORD_RESULT = "admin.users.reset_password.result"
ADMIN_GUILDS_LIST = "admin.guilds.list"
ADMIN_GUILDS_LIST_RESULT = "admin.guilds.list.result"
ADMIN_GUILDS_DELETE = "admin.guilds.delete"
ADMIN_GUILDS_DELETE_RESULT = "admin.guilds.delete.result"
ADMIN_ACCOUNT_REQUESTED = "admin.account_requested"

# Users
USER_PROFILE = "user.profile"
USER_PROFILE_RESULT = "user.profile.result"
USER_UPDATE = "user.update"
USER_UPDATE_RESULT = "user.update.result"
USER_AVATAR_SET = "user.avatar.set"
USER_AVATAR_SET_RESULT = "user.avatar.set.result"
USER_PASSWORD_CHANGE = "user.password.change"
USER_PASSWORD_CHANGE_RESULT = "user.password.change.result"
USER_SESSIONS_LIST = "user.sessions.list"
USER_SESSIONS_LIST_RESULT = "user.sessions.list.result"
USER_SESSIONS_REVOKE = "user.sessions.revoke"
USER_SESSIONS_REVOKE_RESULT = "user.sessions.revoke.result"
USER_SEARCH = "user.search"
USER_SEARCH_RESULT = "user.search.result"
USER_UPDATED = "user.updated"

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
GUILD_DELETE = "guild.delete"
GUILD_DELETE_RESULT = "guild.delete.result"
GUILD_MEMBERS = "guild.members"
GUILD_MEMBERS_RESULT = "guild.members.result"
GUILD_CONFIG_UPDATE = "guild.config.update"
GUILD_CONFIG_UPDATE_RESULT = "guild.config.update.result"
GUILD_INVITE_CREATE = "guild.invite.create"
GUILD_INVITE_CREATE_RESULT = "guild.invite.create.result"
GUILD_BANS_LIST = "guild.bans.list"
GUILD_BANS_LIST_RESULT = "guild.bans.list.result"
GUILD_AUDIT_LOG = "guild.audit_log"
GUILD_AUDIT_LOG_RESULT = "guild.audit_log.result"
GUILD_UPDATED = "guild.updated"
GUILD_REMOVED = "guild.removed"
GUILD_MEMBER_JOINED = "guild.member_joined"
GUILD_MEMBER_LEFT = "guild.member_left"
GUILD_MEMBER_UPDATED = "guild.member_updated"
GUILD_PERMISSIONS_CHANGED = "guild.permissions_changed"

# Roles
ROLE_LIST = "role.list"
ROLE_LIST_RESULT = "role.list.result"
ROLE_CREATE = "role.create"
ROLE_CREATE_RESULT = "role.create.result"
ROLE_UPDATE = "role.update"
ROLE_UPDATE_RESULT = "role.update.result"
ROLE_REORDER = "role.reorder"
ROLE_REORDER_RESULT = "role.reorder.result"
ROLE_DELETE = "role.delete"
ROLE_DELETE_RESULT = "role.delete.result"
ROLE_CREATED = "role.created"
ROLE_UPDATED = "role.updated"
ROLE_DELETED = "role.deleted"

# Members / moderation
MEMBER_ROLES_SET = "member.roles.set"
MEMBER_ROLES_SET_RESULT = "member.roles.set.result"
MEMBER_KICK = "member.kick"
MEMBER_KICK_RESULT = "member.kick.result"
MEMBER_BAN = "member.ban"
MEMBER_BAN_RESULT = "member.ban.result"
MEMBER_UNBAN = "member.unban"
MEMBER_UNBAN_RESULT = "member.unban.result"
MEMBER_TIMEOUT = "member.timeout"
MEMBER_TIMEOUT_RESULT = "member.timeout.result"

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
CHANNEL_ACK = "channel.ack"
CHANNEL_ACK_RESULT = "channel.ack.result"
CHANNEL_CREATED = "channel.created"
CHANNEL_UPDATED = "channel.updated"
CHANNEL_DELETED = "channel.deleted"

# Direct messages
DM_LIST = "dm.list"
DM_LIST_RESULT = "dm.list.result"
DM_OPEN = "dm.open"
DM_OPEN_RESULT = "dm.open.result"
DM_CREATE_GROUP = "dm.create_group"
DM_CREATE_GROUP_RESULT = "dm.create_group.result"
DM_UPDATE = "dm.update"
DM_UPDATE_RESULT = "dm.update.result"
DM_ADD_RECIPIENT = "dm.add_recipient"
DM_ADD_RECIPIENT_RESULT = "dm.add_recipient.result"
DM_LEAVE = "dm.leave"
DM_LEAVE_RESULT = "dm.leave.result"
DM_CREATED = "dm.created"
DM_UPDATED = "dm.updated"

# Messaging
MESSAGE_SEND = "message.send"
MESSAGE_SEND_RESULT = "message.send.result"
MESSAGE_EDIT = "message.edit"
MESSAGE_EDIT_RESULT = "message.edit.result"
MESSAGE_DELETE = "message.delete"
MESSAGE_DELETE_RESULT = "message.delete.result"
MESSAGE_NEW = "message.new"
MESSAGE_UPDATED = "message.updated"
MESSAGE_DELETED = "message.deleted"

# Reactions
REACTION_ADD = "reaction.add"
REACTION_ADD_RESULT = "reaction.add.result"
REACTION_REMOVE = "reaction.remove"
REACTION_REMOVE_RESULT = "reaction.remove.result"
REACTION_ADDED = "reaction.added"
REACTION_REMOVED = "reaction.removed"

# Typing
TYPING_START = "typing.start"
TYPING_START_RESULT = "typing.start.result"
TYPING_STARTED = "typing.started"

# Read state
READ_STATE_LIST = "read_state.list"
READ_STATE_LIST_RESULT = "read_state.list.result"
READ_STATE_UPDATED = "read_state.updated"

# Notification preferences
NOTIFY_PREFS_GET = "notify.prefs.get"
NOTIFY_PREFS_GET_RESULT = "notify.prefs.get.result"
NOTIFY_PREFS_SET = "notify.prefs.set"
NOTIFY_PREFS_SET_RESULT = "notify.prefs.set.result"
NOTIFY_PREFS_UPDATED = "notify.prefs.updated"

# Presence
PRESENCE_LIST = "presence.list"
PRESENCE_LIST_RESULT = "presence.list.result"
PRESENCE_SET = "presence.set"
PRESENCE_SET_RESULT = "presence.set.result"
PRESENCE_UPDATE = "presence.update"

# Generic error for frames that can't be attributed to a request type
ERROR = "error"

# Types a client may send before authenticating.
PRE_AUTH_TYPES = frozenset(
    {SERVER_INFO, SETUP_CLAIM, AUTH_REGISTER, AUTH_LOGIN, AUTH_RESUME, AUTH_REQUEST_ACCOUNT}
)

# Requests answered with auth.ok / auth.error instead of X.result / X.error.
AUTH_OK_TYPES = frozenset({AUTH_REGISTER, AUTH_LOGIN, AUTH_RESUME, SETUP_CLAIM})

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
SETUP_REQUIRED = "setup_required"
INVALID_SETUP_CODE = "invalid_setup_code"
SETUP_ALREADY_DONE = "setup_already_done"
ACCOUNT_DISABLED = "account_disabled"
BANNED = "banned"
TIMED_OUT = "timed_out"
AVATAR_INVALID = "avatar_invalid"
TOO_MANY_REACTIONS = "too_many_reactions"
DM_LIMIT = "dm_limit"
INVALID_CURRENT_PASSWORD = "invalid_current_password"

ERROR_CODES = frozenset(
    {
        INVALID_CREDENTIALS, SESSION_EXPIRED, REGISTRATION_CLOSED,
        REGISTRATION_PENDING_APPROVAL, INVITE_INVALID, NOT_FOUND, FORBIDDEN,
        BAD_REQUEST, UNKNOWN_TYPE, NOT_AUTHENTICATED, USERNAME_TAKEN,
        INVALID_USERNAME, INVALID_PASSWORD, CONTENT_TOO_LONG, RATE_LIMITED,
        GUILD_CREATION_DISABLED, ALREADY_MEMBER, INTERNAL_ERROR,
        SETUP_REQUIRED, INVALID_SETUP_CODE, SETUP_ALREADY_DONE, ACCOUNT_DISABLED,
        BANNED, TIMED_OUT, AVATAR_INVALID, TOO_MANY_REACTIONS, DM_LIMIT,
        INVALID_CURRENT_PASSWORD,
    }
)

# --- Permissions (PROTOCOL.md §5a) -------------------------------------------

PERMS = {
    "VIEW_CHANNEL": 1 << 0,
    "SEND_MESSAGES": 1 << 1,
    "READ_HISTORY": 1 << 2,
    "ADD_REACTIONS": 1 << 3,
    "MENTION_EVERYONE": 1 << 4,
    "MANAGE_MESSAGES": 1 << 5,
    "MANAGE_CHANNELS": 1 << 6,
    "MANAGE_ROLES": 1 << 7,
    "MANAGE_GUILD": 1 << 8,
    "CREATE_INVITE": 1 << 9,
    "KICK_MEMBERS": 1 << 10,
    "BAN_MEMBERS": 1 << 11,
    "MODERATE_MEMBERS": 1 << 12,
    "VIEW_AUDIT_LOG": 1 << 13,
    "ADMINISTRATOR": 1 << 14,
}

# --- Limits ------------------------------------------------------------------

MAX_FRAME_BYTES = 64 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN_BYTES = 8
PASSWORD_MAX_BYTES = 72
CONTENT_MAX_CHARS = 2000
GUILD_NAME_MAX = 100
SERVER_NAME_MAX = 64
CHANNEL_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 100
DISPLAY_NAME_MAX = 32
BIO_MAX = 190
CUSTOM_STATUS_MAX = 128
ROLE_NAME_MAX = 32
MAX_ROLES = 50
EMOJI_MAX_CHARS = 32
MAX_REACTION_EMOJI = 20
AVATAR_MAX_BYTES = 40 * 1024
GROUP_DM_MAX = 10
GROUP_DM_NAME_MAX = 64
BAN_REASON_MAX = 256
MAX_TIMEOUT_SECONDS = 28 * 24 * 3600
MAX_BAN_DELETE_SECONDS = 7 * 24 * 3600
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

PRESENCE_PREFS = ("online", "idle", "dnd", "invisible")
NOTIFY_LEVELS = ("all", "mentions", "none")


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


def req_id(payload: dict, key: str) -> str:
    """A snowflake id field (decimal string)."""
    val = payload.get(key)
    if not isinstance(val, str) or not val.isdigit() or len(val) > 20:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be an id")
    return val


def opt_id(payload: dict, key: str) -> str | None:
    return None if payload.get(key) is None else req_id(payload, key)


def id_list(payload: dict, key: str, *, max_len: int) -> list[str]:
    val = payload.get(key)
    if not isinstance(val, list) or len(val) > max_len:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be a list of at most {max_len} ids")
    out = []
    for item in val:
        if not isinstance(item, str) or not item.isdigit() or len(item) > 20:
            raise ProtocolError(BAD_REQUEST, f"'{key}' must contain ids")
        if item not in out:
            out.append(item)
    return out


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


def opt_enum(payload: dict, key: str, allowed: tuple[str, ...]) -> str | None:
    val = payload.get(key)
    if val is None:
        return None
    if val not in allowed:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be one of {', '.join(allowed)}")
    return val


def opt_text(payload: dict, key: str, max_len: int) -> str | None:
    """Optional free text: trimmed; "" means clear (returned as "")."""
    val = opt_str(payload, key)
    if val is None:
        return None
    val = val.strip()
    if len(val) > max_len:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be at most {max_len} characters")
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


def validate_server_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ProtocolError(BAD_REQUEST, "Server name must be non-empty")
    name = name.strip()
    if len(name) > SERVER_NAME_MAX:
        raise ProtocolError(BAD_REQUEST, f"Server name must be at most {SERVER_NAME_MAX} characters")
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


def validate_color(color: Any) -> str | None:
    """'#rrggbb' or None (no color)."""
    if color is None:
        return None
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise ProtocolError(BAD_REQUEST, "Colors must look like #rrggbb")
    return color.lower()


def validate_emoji(emoji: Any) -> str:
    # Unicode emoji only: short, no whitespace, and at least one code point
    # outside basic Latin/punctuation (keycaps like 1️⃣ carry U+20E3).
    if (
        not isinstance(emoji, str)
        or not emoji
        or len(emoji.encode("utf-16-le")) // 2 > EMOJI_MAX_CHARS  # UTF-16 units, like JS .length
        or any(c.isspace() for c in emoji)
        or not any(ord(c) >= 0x2000 for c in emoji)
    ):
        raise ProtocolError(BAD_REQUEST, "'emoji' must be a unicode emoji")
    return emoji
