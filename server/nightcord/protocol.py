"""Wire-format constants and helpers.

Implemented directly against docs/PROTOCOL.md. If this file and the spec
disagree, the spec wins. tests/test_protocol_sync.py enforces that the type
names here match the spec tables and client/js/protocol.js.
"""

from __future__ import annotations

import re
from typing import Any

PROTOCOL_VERSION = "0.16"

# --- Message types -----------------------------------------------------------

# Setup
SETUP_CLAIM = "setup.claim"

# Legal documents
LEGAL_GET = "legal.get"
LEGAL_GET_RESULT = "legal.get.result"
LEGAL_ACCEPT = "legal.accept"
LEGAL_ACCEPT_RESULT = "legal.accept.result"

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
SERVER_CONFIG_UPDATED = "server.config.updated"

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
ADMIN_STAFF_SET = "admin.staff.set"
ADMIN_STAFF_SET_RESULT = "admin.staff.set.result"
ADMIN_USERS_MUTE = "admin.users.mute"
ADMIN_USERS_MUTE_RESULT = "admin.users.mute.result"
ADMIN_USERS_DELETE = "admin.users.delete"
ADMIN_USERS_DELETE_RESULT = "admin.users.delete.result"
ADMIN_IP_BANS_LIST = "admin.ip_bans.list"
ADMIN_IP_BANS_LIST_RESULT = "admin.ip_bans.list.result"
ADMIN_IP_BANS_ADD = "admin.ip_bans.add"
ADMIN_IP_BANS_ADD_RESULT = "admin.ip_bans.add.result"
ADMIN_IP_BANS_REMOVE = "admin.ip_bans.remove"
ADMIN_IP_BANS_REMOVE_RESULT = "admin.ip_bans.remove.result"
ADMIN_DEVICE_BANS_LIST = "admin.device_bans.list"
ADMIN_DEVICE_BANS_LIST_RESULT = "admin.device_bans.list.result"
ADMIN_DEVICE_BANS_ADD = "admin.device_bans.add"
ADMIN_DEVICE_BANS_ADD_RESULT = "admin.device_bans.add.result"
ADMIN_DEVICE_BANS_REMOVE = "admin.device_bans.remove"
ADMIN_DEVICE_BANS_REMOVE_RESULT = "admin.device_bans.remove.result"
ADMIN_AUDIT_LOG = "admin.audit_log"
ADMIN_AUDIT_LOG_RESULT = "admin.audit_log.result"
ADMIN_STATS = "admin.stats"
ADMIN_STATS_RESULT = "admin.stats.result"
ADMIN_LEGAL_SET = "admin.legal.set"
ADMIN_LEGAL_SET_RESULT = "admin.legal.set.result"
ADMIN_USERS_SET_PERKS = "admin.users.set_perks"
ADMIN_USERS_SET_PERKS_RESULT = "admin.users.set_perks.result"
ADMIN_USERS_SET_BADGES = "admin.users.set_badges"
ADMIN_USERS_SET_BADGES_RESULT = "admin.users.set_badges.result"

# Badges (server owner only)
BADGE_LIST = "badge.list"
BADGE_LIST_RESULT = "badge.list.result"
BADGE_CREATE = "badge.create"
BADGE_CREATE_RESULT = "badge.create.result"
BADGE_UPDATE = "badge.update"
BADGE_UPDATE_RESULT = "badge.update.result"
BADGE_DELETE = "badge.delete"
BADGE_DELETE_RESULT = "badge.delete.result"

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
USER_DELETE = "user.delete"
USER_DELETE_RESULT = "user.delete.result"
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
GUILD_INVITE_LIST = "guild.invite.list"
GUILD_INVITE_LIST_RESULT = "guild.invite.list.result"
GUILD_INVITE_REVOKE = "guild.invite.revoke"
GUILD_INVITE_REVOKE_RESULT = "guild.invite.revoke.result"
GUILD_INVITE_RESOLVE = "guild.invite.resolve"
GUILD_INVITE_RESOLVE_RESULT = "guild.invite.resolve.result"
GUILD_ICON_SET = "guild.icon.set"
GUILD_ICON_SET_RESULT = "guild.icon.set.result"
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
GUILD_EMOJIS_UPDATED = "guild.emojis_updated"
GUILD_STICKERS_UPDATED = "guild.stickers_updated"

# Custom emoji and stickers
EMOJI_CREATE = "emoji.create"
EMOJI_CREATE_RESULT = "emoji.create.result"
EMOJI_UPDATE = "emoji.update"
EMOJI_UPDATE_RESULT = "emoji.update.result"
EMOJI_DELETE = "emoji.delete"
EMOJI_DELETE_RESULT = "emoji.delete.result"
EMOJI_INFO = "emoji.info"
EMOJI_INFO_RESULT = "emoji.info.result"
STICKER_CREATE = "sticker.create"
STICKER_CREATE_RESULT = "sticker.create.result"
STICKER_UPDATE = "sticker.update"
STICKER_UPDATE_RESULT = "sticker.update.result"
STICKER_DELETE = "sticker.delete"
STICKER_DELETE_RESULT = "sticker.delete.result"

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
MEMBER_NICKNAME_SET = "member.nickname.set"
MEMBER_NICKNAME_SET_RESULT = "member.nickname.set.result"

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
CHANNEL_REORDER = "channel.reorder"
CHANNEL_REORDER_RESULT = "channel.reorder.result"
CHANNEL_PINS = "channel.pins"
CHANNEL_PINS_RESULT = "channel.pins.result"
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
DM_REQUEST_ACCEPT = "dm.request.accept"
DM_REQUEST_ACCEPT_RESULT = "dm.request.accept.result"
DM_REQUEST_DECLINE = "dm.request.decline"
DM_REQUEST_DECLINE_RESULT = "dm.request.decline.result"
DM_CREATED = "dm.created"
DM_UPDATED = "dm.updated"

# Messaging
MESSAGE_SEND = "message.send"
MESSAGE_SEND_RESULT = "message.send.result"
MESSAGE_EDIT = "message.edit"
MESSAGE_EDIT_RESULT = "message.edit.result"
MESSAGE_DELETE = "message.delete"
MESSAGE_DELETE_RESULT = "message.delete.result"
MESSAGE_PIN = "message.pin"
MESSAGE_PIN_RESULT = "message.pin.result"
MESSAGE_UNPIN = "message.unpin"
MESSAGE_UNPIN_RESULT = "message.unpin.result"
MESSAGE_SEARCH = "message.search"
MESSAGE_SEARCH_RESULT = "message.search.result"
MESSAGE_FORWARD = "message.forward"
MESSAGE_FORWARD_RESULT = "message.forward.result"
MESSAGE_EMBEDS_SUPPRESS = "message.embeds.suppress"
MESSAGE_EMBEDS_SUPPRESS_RESULT = "message.embeds.suppress.result"
MESSAGE_NEW = "message.new"
MESSAGE_UPDATED = "message.updated"
MESSAGE_DELETED = "message.deleted"

# Saved messages and private notes
SAVED_LIST = "saved.list"
SAVED_LIST_RESULT = "saved.list.result"
SAVED_ADD = "saved.add"
SAVED_ADD_RESULT = "saved.add.result"
SAVED_REMOVE = "saved.remove"
SAVED_REMOVE_RESULT = "saved.remove.result"
SAVED_UPDATED = "saved.updated"
USER_NOTE_SET = "user.note.set"
USER_NOTE_SET_RESULT = "user.note.set.result"
USER_NOTE_UPDATED = "user.note.updated"

# Polls
POLL_VOTE = "poll.vote"
POLL_VOTE_RESULT = "poll.vote.result"
POLL_END = "poll.end"
POLL_END_RESULT = "poll.end.result"
POLL_UPDATED = "poll.updated"

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

# Voice (placeholder: presence in a voice channel, no audio yet)
VOICE_JOIN = "voice.join"
VOICE_JOIN_RESULT = "voice.join.result"
VOICE_LEAVE = "voice.leave"
VOICE_LEAVE_RESULT = "voice.leave.result"
VOICE_STATE_SET = "voice.state.set"
VOICE_STATE_SET_RESULT = "voice.state.set.result"
VOICE_STATE_UPDATED = "voice.state_updated"

# Friends and blocking
FRIEND_LIST = "friend.list"
FRIEND_LIST_RESULT = "friend.list.result"
FRIEND_REQUEST = "friend.request"
FRIEND_REQUEST_RESULT = "friend.request.result"
FRIEND_ACCEPT = "friend.accept"
FRIEND_ACCEPT_RESULT = "friend.accept.result"
FRIEND_REMOVE = "friend.remove"
FRIEND_REMOVE_RESULT = "friend.remove.result"
USER_BLOCK = "user.block"
USER_BLOCK_RESULT = "user.block.result"
USER_UNBLOCK = "user.unblock"
USER_UNBLOCK_RESULT = "user.unblock.result"
RELATIONSHIP_UPDATED = "relationship.updated"
RELATIONSHIP_REMOVED = "relationship.removed"

# Announcements
ANNOUNCEMENT_LIST = "announcement.list"
ANNOUNCEMENT_LIST_RESULT = "announcement.list.result"
ANNOUNCEMENT_CREATE = "announcement.create"
ANNOUNCEMENT_CREATE_RESULT = "announcement.create.result"
ANNOUNCEMENT_UPDATE = "announcement.update"
ANNOUNCEMENT_UPDATE_RESULT = "announcement.update.result"
ANNOUNCEMENT_DELETE = "announcement.delete"
ANNOUNCEMENT_DELETE_RESULT = "announcement.delete.result"
ANNOUNCEMENT_ACK = "announcement.ack"
ANNOUNCEMENT_ACK_RESULT = "announcement.ack.result"
ANNOUNCEMENT_CREATED = "announcement.created"
ANNOUNCEMENT_UPDATED = "announcement.updated"
ANNOUNCEMENT_DELETED = "announcement.deleted"
ANNOUNCEMENT_ACKED = "announcement.acked"

# Generic error for frames that can't be attributed to a request type
ERROR = "error"

# Types a client may send before authenticating.
PRE_AUTH_TYPES = frozenset(
    {SERVER_INFO, LEGAL_GET, SETUP_CLAIM, AUTH_REGISTER, AUTH_LOGIN, AUTH_RESUME, AUTH_REQUEST_ACCOUNT}
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
FILE_TOO_LARGE = "file_too_large"
MUTED = "muted"
IP_BANNED = "ip_banned"
DEVICE_BANNED = "device_banned"
SLOWMODE = "slowmode"
INVITE_EXPIRED = "invite_expired"
LEGAL_REQUIRED = "legal_required"
VOICE_DISABLED = "voice_disabled"
PIN_LIMIT = "pin_limit"
FEATURE_DISABLED = "feature_disabled"
MEDIA_INVALID = "media_invalid"
BLOCKED = "blocked"
DM_NOT_ALLOWED = "dm_not_allowed"
REQUEST_PENDING = "request_pending"
ALREADY_FRIENDS = "already_friends"
NOT_FRIENDS = "not_friends"
EMBEDS_DISABLED = "embeds_disabled"
POLL_ENDED = "poll_ended"

ERROR_CODES = frozenset(
    {
        INVALID_CREDENTIALS, SESSION_EXPIRED, REGISTRATION_CLOSED,
        REGISTRATION_PENDING_APPROVAL, INVITE_INVALID, NOT_FOUND, FORBIDDEN,
        BAD_REQUEST, UNKNOWN_TYPE, NOT_AUTHENTICATED, USERNAME_TAKEN,
        INVALID_USERNAME, INVALID_PASSWORD, CONTENT_TOO_LONG, RATE_LIMITED,
        GUILD_CREATION_DISABLED, ALREADY_MEMBER, INTERNAL_ERROR,
        SETUP_REQUIRED, INVALID_SETUP_CODE, SETUP_ALREADY_DONE, ACCOUNT_DISABLED,
        BANNED, TIMED_OUT, AVATAR_INVALID, TOO_MANY_REACTIONS, DM_LIMIT,
        INVALID_CURRENT_PASSWORD, FILE_TOO_LARGE, MUTED, IP_BANNED, DEVICE_BANNED,
        SLOWMODE, INVITE_EXPIRED, LEGAL_REQUIRED, VOICE_DISABLED, PIN_LIMIT,
        FEATURE_DISABLED, MEDIA_INVALID, BLOCKED, DM_NOT_ALLOWED, REQUEST_PENDING, ALREADY_FRIENDS,
        NOT_FRIENDS, EMBEDS_DISABLED, POLL_ENDED,
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
    "ATTACH_FILES": 1 << 15,
    "CONNECT": 1 << 16,
    "CHANGE_NICKNAME": 1 << 17,
    "MANAGE_NICKNAMES": 1 << 18,
    "MANAGE_EXPRESSIONS": 1 << 19,
}

# --- Limits ------------------------------------------------------------------

MAX_FRAME_BYTES = 64 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN_BYTES = 8
PASSWORD_MAX_BYTES = 72
CONTENT_MAX_CHARS = 2000
GUILD_NAME_MAX = 100
SERVER_NAME_MAX = 64
SERVER_DESCRIPTION_MAX = 2000
CHANNEL_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 100
DISPLAY_NAME_MAX = 32
BIO_MAX = 190
CUSTOM_STATUS_MAX = 128
ROLE_NAME_MAX = 32
MAX_ROLES = 50
EMOJI_MAX_CHARS = 32  # a unicode emoji; custom emoji use CUSTOM_EMOJI_RE
MAX_REACTION_EMOJI = 20
AVATAR_MAX_BYTES = 40 * 1024
GROUP_DM_MAX = 10
GROUP_DM_NAME_MAX = 64
BAN_REASON_MAX = 256
MAX_TIMEOUT_SECONDS = 28 * 24 * 3600
MAX_BAN_DELETE_SECONDS = 7 * 24 * 3600
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

NICKNAME_MAX = 32
TOPIC_MAX = 1024
CHANNEL_TITLE_MAX = 32  # voice channel and category names (free text)
MAX_CHANNELS = 200
MAX_ATTACHMENTS = 10
FILENAME_MAX = 128
DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_UPLOAD_BYTES_CEILING = 1024 * 1024 * 1024
LEGAL_MAX_CHARS = 30000
MAX_PINS = 50
SEARCH_PAGE = 25
SLOWMODE_PRESETS = (0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600)
INVITE_MAX_USES = (0, 1, 5, 10, 25, 50, 100)
INVITE_MAX_AGES = (0, 1800, 3600, 21600, 43200, 86400, 604800)
VANITY_RE = re.compile(r"^[a-z0-9-]{3,32}$")
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAX_MUTE_SECONDS = 365 * 24 * 3600

# Custom emoji, stickers and customisation (PROTOCOL.md §4 Emoji, §8d)
EMOJI_NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,32}$")
CUSTOM_EMOJI_RE = re.compile(r"^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$")
MAX_GUILD_EMOJI = 200
MAX_BADGES = 50
MAX_USER_BADGES = 8
BADGE_NAME_MAX = 30
BADGE_DESCRIPTION_MAX = 100
# The built-in badge: no row, no image; clients draw it themselves.
BADGE_VERIFIED = "verified"
MAX_GUILD_STICKERS = 60
STICKER_NAME_MAX = 30
STICKER_DESCRIPTION_MAX = 100
MAX_STICKERS_PER_MESSAGE = 1
MAX_ROLE_COLORS = 3
PROFILE_COLORS = 2
MEDIA_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
# kind: (max bytes, max width/height or None)
MEDIA_KINDS = {
    "emoji": (256 * 1024, 256),
    "sticker": (512 * 1024, 320),
    "avatar": (1024 * 1024, None),
    "guild_icon": (1024 * 1024, None),
    "banner": (2 * 1024 * 1024, None),
    "guild_banner": (2 * 1024 * 1024, None),
    "role_icon": (256 * 1024, None),
    "badge": (256 * 1024, 128),
}
CUSTOMIZATION_MODES = ("off", "allowlist", "on")
CUSTOMIZATION_FEATURES = (
    "profile_banner", "profile_colors", "animated_media", "guild_banner", "gradient_roles", "role_icons",
    "client_themes",
)

# Guild system message flags
SYSTEM_JOIN = 1
SYSTEM_LEAVE = 2

MESSAGE_TYPES = ("default", "member_join", "member_leave", "pin")
CHANNEL_KINDS = ("text", "voice", "category")
STAFF_ROLES = ("none", "moderator", "admin")

PRESENCE_PREFS = ("online", "idle", "dnd", "invisible")
# How long a custom status lasts. "today" is the end of the current UTC day.
CUSTOM_STATUS_DURATIONS = {"30m": 1800, "1h": 3600, "4h": 4 * 3600, "today": None, "never": None}
NOTIFY_LEVELS = ("all", "mentions", "none")
DM_PRIVACY = ("everyone", "requests", "friends")
USER_SEARCH_MODES = ("off", "staff", "on")
ANNOUNCEMENT_MAX_CHARS = 4000
# Link embeds (§4 Embed): the server fetches pages people post.
MAX_EMBEDS_PER_MESSAGE = 5
EMBED_FETCH_TIMEOUT = 5
EMBED_PAGE_MAX_BYTES = 1024 * 1024
EMBED_IMAGE_MAX_BYTES = 8 * 1024 * 1024
EMBED_VIDEO_MAX_BYTES = 25 * 1024 * 1024
EMBED_VIDEO_FETCH_TIMEOUT = 30
EMBED_CACHE_SECONDS = 24 * 3600
EMBED_FAIL_CACHE_SECONDS = 600
EMBED_CACHE_MAX_ROWS = 20000
PROXY_CACHE_DAYS = 7

# Slash commands the server rolls, so nobody can fake a result (§4 Message).
SERVER_COMMANDS = ("roll", "8ball", "coinflip", "choose")
COMMAND_ARGS_MAX = 200
MAX_DICE = 20
MAX_DIE_SIDES = 1000
MAX_DICE_MODIFIER = 10000
MAX_CHOICES = 20

# Polls (§4 Poll)
POLL_QUESTION_MAX = 300
POLL_ANSWER_MAX = 55
POLL_MIN_ANSWERS = 2
POLL_MAX_ANSWERS = 10
POLL_DURATIONS = {"1h": 3600, "4h": 4 * 3600, "8h": 8 * 3600, "1d": 86400, "3d": 3 * 86400, "1w": 7 * 86400}

# Saved messages and private notes (§4 Saved message, User note)
SAVED_PAGE = 50
MAX_SAVED = 500
USER_NOTE_MAX = 256

# Forwards (§4 Forward): how much of the original travels with the copy.
FORWARD_CONTENT_MAX = 2000
FORWARD_ATTACHMENTS_MAX = 10
MAX_ACCOUNTS_PER_CLIENT = 20


class ProtocolError(Exception):
    """Raised by handlers; becomes an `X.error` (or `auth.error`) frame."""

    def __init__(self, code: str, message: str | None = None, **extra: Any):
        assert code in ERROR_CODES, code
        super().__init__(message or code)
        self.code = code
        self.message = message or code.replace("_", " ")
        self.extra = extra


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


def error_payload(code: str, message: str, **extra: Any) -> dict:
    return {"code": code, "message": message, **extra}


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


def validate_server_description(text: Any) -> str:
    if not isinstance(text, str):
        raise ProtocolError(BAD_REQUEST, "Server description must be a string")
    text = text.strip()
    if len(text) > SERVER_DESCRIPTION_MAX:
        raise ProtocolError(BAD_REQUEST, f"Server description must be at most {SERVER_DESCRIPTION_MAX} characters")
    return text


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


def validate_content(content: Any, *, allow_empty: bool = False) -> str:
    if content is None and allow_empty:
        return ""
    if not isinstance(content, str):
        raise ProtocolError(BAD_REQUEST, "'content' must be a string")
    content = content.strip()
    if not content and not allow_empty:
        raise ProtocolError(BAD_REQUEST, "Message is empty")
    if len(content) > CONTENT_MAX_CHARS:
        raise ProtocolError(CONTENT_TOO_LONG, "Message exceeds 2000 characters")
    return content


def validate_channel_title(name: Any) -> str:
    """Voice channel / category names: free text."""
    if not isinstance(name, str) or not name.strip():
        raise ProtocolError(BAD_REQUEST, "Name can't be empty")
    name = " ".join(name.split())
    if len(name) > CHANNEL_TITLE_MAX:
        raise ProtocolError(BAD_REQUEST, f"Name must be at most {CHANNEL_TITLE_MAX} characters")
    return name


def opt_device_id(payload: dict) -> str | None:
    val = payload.get("device_id")
    if val is None:
        return None
    if not isinstance(val, str) or not DEVICE_ID_RE.match(val):
        raise ProtocolError(BAD_REQUEST, "'device_id' must be 16-64 characters: letters, digits, _ -")
    return val


def validate_color(color: Any) -> str | None:
    """'#rrggbb' or None (no color)."""
    if color is None:
        return None
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise ProtocolError(BAD_REQUEST, "Colors must look like #rrggbb")
    return color.lower()


def validate_emoji(emoji: Any, *, allow_custom: bool = True) -> str:
    """A unicode emoji, or (allow_custom) a custom one written <:name:id> / <a:name:id>."""
    if allow_custom and isinstance(emoji, str) and CUSTOM_EMOJI_RE.match(emoji):
        return emoji
    # Unicode emoji: short, no whitespace, and at least one code point
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


def validate_emoji_name(name: Any) -> str:
    if not isinstance(name, str) or not EMOJI_NAME_RE.match(name.strip()):
        raise ProtocolError(BAD_REQUEST, "Emoji names must be 2-32 characters: letters, digits and _")
    return name.strip()


def validate_colors(colors: Any, *, min_len: int, max_len: int, key: str) -> list[str] | None:
    """A list of '#rrggbb' strings, or None."""
    if colors is None:
        return None
    if not isinstance(colors, list) or not min_len <= len(colors) <= max_len:
        raise ProtocolError(BAD_REQUEST, f"'{key}' must be a list of {min_len}-{max_len} colors")
    return [validate_color(c) for c in colors]
