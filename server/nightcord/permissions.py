"""Guild permission computation (PROTOCOL.md §5a).

Discord's model without per-member overwrites:

1. The guild owner has every permission.
2. base = @everyone | each of the member's roles. ADMINISTRATOR grants all.
3. In a channel: apply the @everyone overwrite (deny, then allow), then the
   union of the member's role overwrites (deny, then allow). A channel synced
   with its category uses the category's overwrites.
4. Without VIEW_CHANNEL a member has no permissions in that channel.
5. A timed-out member keeps only VIEW_CHANNEL and READ_HISTORY.
6. A ghost (server-owner override) membership has VIEW_CHANNEL and
   READ_HISTORY everywhere, ignoring overwrites, and nothing else.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .protocol import PERMS

if TYPE_CHECKING:
    from .db import Database

VIEW_CHANNEL = PERMS["VIEW_CHANNEL"]
SEND_MESSAGES = PERMS["SEND_MESSAGES"]
READ_HISTORY = PERMS["READ_HISTORY"]
ADD_REACTIONS = PERMS["ADD_REACTIONS"]
MENTION_EVERYONE = PERMS["MENTION_EVERYONE"]
MANAGE_MESSAGES = PERMS["MANAGE_MESSAGES"]
MANAGE_CHANNELS = PERMS["MANAGE_CHANNELS"]
MANAGE_ROLES = PERMS["MANAGE_ROLES"]
MANAGE_GUILD = PERMS["MANAGE_GUILD"]
CREATE_INVITE = PERMS["CREATE_INVITE"]
KICK_MEMBERS = PERMS["KICK_MEMBERS"]
BAN_MEMBERS = PERMS["BAN_MEMBERS"]
MODERATE_MEMBERS = PERMS["MODERATE_MEMBERS"]
VIEW_AUDIT_LOG = PERMS["VIEW_AUDIT_LOG"]
ADMINISTRATOR = PERMS["ADMINISTRATOR"]
ATTACH_FILES = PERMS["ATTACH_FILES"]
CONNECT = PERMS["CONNECT"]
CHANGE_NICKNAME = PERMS["CHANGE_NICKNAME"]
MANAGE_NICKNAMES = PERMS["MANAGE_NICKNAMES"]
MANAGE_EXPRESSIONS = PERMS["MANAGE_EXPRESSIONS"]

ALL = 0
for _bit in PERMS.values():
    ALL |= _bit

# Permissions that can be set per channel with overwrites.
CHANNEL_PERMS = (
    VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | ADD_REACTIONS
    | MENTION_EVERYONE | MANAGE_MESSAGES | MANAGE_CHANNELS | ATTACH_FILES | CONNECT
)
READ_ONLY = VIEW_CHANNEL | READ_HISTORY
DM_PERMS = VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | ADD_REACTIONS | ATTACH_FILES
DEFAULT_EVERYONE = (
    VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | ADD_REACTIONS | CREATE_INVITE
    | ATTACH_FILES | CONNECT | CHANGE_NICKNAME
)

OWNER_RANK = 1 << 30  # above any role position


@dataclass(frozen=True)
class MemberPerms:
    """Cached, time-independent facts about one member of one guild."""

    guild_id: str
    user_id: str
    is_owner: bool
    ghost: bool
    base: int  # before timeout is applied
    role_ids: frozenset[str]
    rank: int  # highest role position; OWNER_RANK for the owner
    timed_out_until: str | None

    def timed_out(self, now_iso: str | None = None) -> bool:
        if not self.timed_out_until or self.is_owner:
            return False
        now_iso = now_iso or _now_iso()
        return self.timed_out_until > now_iso


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compute_base(*, is_owner: bool, ghost: bool, everyone: int, role_perms: list[int]) -> int:
    if ghost:
        return READ_ONLY
    if is_owner:
        return ALL
    perms = everyone
    for p in role_perms:
        perms |= p
    if perms & ADMINISTRATOR:
        return ALL
    return perms


def compute_channel(
    mp: MemberPerms, everyone_id: str, overwrites: dict[str, tuple[int, int]], *, now_iso: str | None = None
) -> int:
    if mp.ghost:
        return READ_ONLY
    if mp.is_owner:
        return ALL
    perms = mp.base
    if not perms & ADMINISTRATOR:
        ow = overwrites.get(everyone_id)
        if ow:
            perms = (perms & ~ow[1]) | ow[0]
        allow = deny = 0
        for role_id in mp.role_ids:
            ow = overwrites.get(role_id)
            if ow:
                allow |= ow[0]
                deny |= ow[1]
        perms = (perms & ~deny) | allow
        if not perms & VIEW_CHANNEL:
            perms &= ~CHANNEL_PERMS
    return _apply_timeout(mp, perms, now_iso)


def _apply_timeout(mp: MemberPerms, perms: int, now_iso: str | None) -> int:
    if mp.timed_out(now_iso):
        return perms & READ_ONLY
    return perms


class PermissionService:
    """Computes and caches member permissions. Handlers must call
    invalidate_guild() after changing roles, member roles, membership,
    timeouts or ownership, and invalidate_channel() after overwrites change."""

    def __init__(self, db: "Database"):
        self.db = db
        self._members: dict[tuple[str, str], MemberPerms | None] = {}
        self._overwrites: dict[str, dict[str, tuple[int, int]]] = {}

    def invalidate_guild(self, guild_id: str) -> None:
        self._members = {k: v for k, v in self._members.items() if k[0] != guild_id}
        self._overwrites.clear()

    def invalidate_channel(self, channel_id: str) -> None:
        self._overwrites.pop(channel_id, None)

    def invalidate_all(self) -> None:
        self._members.clear()
        self._overwrites.clear()

    def member(self, guild_id: str, user_id: str) -> MemberPerms | None:
        key = (guild_id, user_id)
        if key not in self._members:
            self._members[key] = self._load(guild_id, user_id)
        return self._members[key]

    def _load(self, guild_id: str, user_id: str) -> MemberPerms | None:
        row = self.db.membership_row(guild_id, user_id)
        if row is None:
            return None
        roles = self.db.roles_for_member(guild_id, user_id)
        everyone = self.db.everyone_permissions(guild_id)
        is_owner = row["role"] == "owner"
        ghost = bool(row["ghost"])
        return MemberPerms(
            guild_id=guild_id,
            user_id=user_id,
            is_owner=is_owner,
            ghost=ghost,
            base=compute_base(
                is_owner=is_owner, ghost=ghost, everyone=everyone,
                role_perms=[r["permissions"] for r in roles],
            ),
            role_ids=frozenset(r["role_id"] for r in roles),
            rank=OWNER_RANK if is_owner else max((r["position"] for r in roles), default=0),
            timed_out_until=row["timed_out_until"],
        )

    def guild_perms(self, guild_id: str, user_id: str) -> int:
        mp = self.member(guild_id, user_id)
        if mp is None:
            return 0
        return _apply_timeout(mp, mp.base, None)

    def overwrites(self, channel_id: str) -> dict[str, tuple[int, int]]:
        if channel_id not in self._overwrites:
            self._overwrites[channel_id] = {
                o["role_id"]: (o["allow"], o["deny"]) for o in self.db.list_overwrites(channel_id)
            }
        return self._overwrites[channel_id]

    @staticmethod
    def overwrite_source(channel: dict) -> str:
        """The channel whose overwrites apply: the category for synced children."""
        if channel.get("perms_synced") and channel.get("parent_id"):
            return channel["parent_id"]
        return channel["channel_id"]

    def channel_perms(self, channel: dict, user_id: str) -> int:
        """Permissions of user_id in a guild channel or DM (0 = no access)."""
        if channel["guild_id"] is None:
            return DM_PERMS if self.db.is_dm_recipient(channel["channel_id"], user_id) else 0
        mp = self.member(channel["guild_id"], user_id)
        if mp is None:
            return 0
        return compute_channel(mp, channel["guild_id"], self.overwrites(self.overwrite_source(channel)))

    def can_view(self, channel: dict, user_id: str) -> bool:
        return bool(self.channel_perms(channel, user_id) & VIEW_CHANNEL)
