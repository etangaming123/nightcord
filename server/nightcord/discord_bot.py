"""The Discord bot behind the Discord link (discord_link.py), on discord.py.

One bot per Nightcord server: whoever runs the server makes a Discord
application, turns on User Install, and puts its token in nightcord.toml as
`discord_token`. The Nightcord server then runs the bot itself, in the same
process and event loop; there's nothing separate to start. People add the
bot to their Discord account and use it anywhere, and everything it answers
is ephemeral (only they see it):

    /nightcord link <code>      link the account that made the code
    /nightcord account          which Nightcord account you're linked to
    /nightcord notifications    switch each kind of DM on or off
    /nightcord sync             copy your Discord name, avatar and banner over
    /nightcord test             send a test notification
    /nightcord unlink           forget the link

Only this module imports discord.py, and only when a token is configured.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

import discord
from discord import app_commands

from . import protocol as P
from .discord_link import DiscordImage, DiscordLink, DiscordProfile, LinkError, Note, display_name

log = logging.getLogger("nightcord.discord")

BRAND = 0x884499
AVATAR_SIZE = 512
BANNER_SIZE = 1024
KIND_LABELS = {
    "mentions": "Mentions and replies",
    "dms": "Direct messages",
    "message_requests": "Message requests",
    "friend_requests": "Friend requests",
    "announcements": "Announcements",
}
SYNC_LABELS = {"display_name": "display name", "avatar": "avatar", "banner": "banner"}


def _when(iso: str | None) -> dt.datetime | None:
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def note_embed(note: Note) -> discord.Embed:
    embed = discord.Embed(
        title=note.title[:256], description=(note.body or None) and note.body[:4096], url=note.url, color=BRAND,
        timestamp=_when(note.timestamp),
    )
    if note.footer:
        embed.set_footer(text=note.footer[:2048])
    return embed


def _image(asset: discord.Asset | None, size: int) -> DiscordImage | None:
    if asset is None:
        return None

    async def read(animated: bool) -> bytes:
        return await asset.replace(size=size, format="gif" if animated else "png").read()

    return DiscordImage(animated=asset.is_animated(), read=read)


async def _say(interaction: discord.Interaction, text: str | None = None, **kwargs) -> None:
    """An ephemeral answer, whether or not the interaction was deferred."""
    if interaction.response.is_done():
        await interaction.followup.send(text, ephemeral=True, **kwargs)
    else:
        await interaction.response.send_message(text, ephemeral=True, **kwargs)


class NotificationsView(discord.ui.View):
    """/nightcord notifications: a button per setting, green when on."""

    def __init__(self, link: DiscordLink, user_id: str, discord_id: int):
        super().__init__(timeout=300)
        self.link = link
        self.user_id = user_id
        self.discord_id = discord_id
        self.draw()

    def settings(self) -> dict:
        return self.link.view(self.user_id) or {}

    def draw(self) -> None:
        self.clear_items()
        s = self.settings()
        if not s:
            return
        for kind in P.DISCORD_NOTIFY_KINDS:
            self.add_item(self._button(KIND_LABELS[kind], s["notify"][kind], ("notify", kind)))
        self.add_item(self._button("Only while I'm not on Nightcord", s["only_when_away"], ("only_when_away", None), row=2))
        self.add_item(self._button("Show message text", s["include_content"], ("include_content", None), row=2))

    def _button(self, label: str, on: bool, key: tuple[str, str | None], row: int | None = None) -> discord.ui.Button:
        button = discord.ui.Button(
            label=label, style=discord.ButtonStyle.success if on else discord.ButtonStyle.secondary, row=row,
        )

        async def pressed(interaction: discord.Interaction) -> None:
            if interaction.user.id != self.discord_id:
                await _say(interaction, "These buttons aren't yours.")
                return
            s = self.settings()
            if not s:
                await interaction.response.edit_message(content="You're not linked any more.", embed=None, view=None)
                return
            what, kind = key
            if what == "notify":
                await self.link.update_settings(self.user_id, notify={kind: not s["notify"][kind]})
            else:
                await self.link.update_settings(self.user_id, **{what: not s[what]})
            self.draw()
            await interaction.response.edit_message(embed=notifications_embed(self.link, self.user_id), view=self)

        button.callback = pressed
        return button


def notifications_embed(link: DiscordLink, user_id: str) -> discord.Embed:
    s = link.view(user_id)
    lines = [f"{'✅' if s['notify'][k] else '⬛'} {KIND_LABELS[k]}" for k in P.DISCORD_NOTIFY_KINDS]
    when = "only while you're not on Nightcord" if s["only_when_away"] else "even while you're on Nightcord"
    text = "with the message text" if s["include_content"] else "without the message text"
    embed = discord.Embed(
        title=f"Notifications from {link.server_name()}",
        description="\n".join(lines) + f"\n\nI'll DM you {when}, {text}. Never while you're on Do Not Disturb.",
        color=BRAND,
    )
    embed.set_footer(text="Press a button to switch it. The same switches are in Nightcord: Settings → Connections.")
    return embed


class NightcordBot(discord.Client):
    def __init__(self, link: DiscordLink):
        # Slash commands and DMs only; the bot never joins voice, so don't
        # warn that voice libraries are missing.
        discord.VoiceClient.warn_nacl = False
        discord.VoiceClient.warn_dave = False
        super().__init__(intents=discord.Intents(guilds=True))
        self.link = link
        self.tree = app_commands.CommandTree(
            self,
            # Added to your account, it works everywhere; added to a server,
            # it shares that server with everyone in it, which Discord
            # sometimes wants before a bot may DM someone.
            allowed_installs=app_commands.AppInstallationType(guild=True, user=True),
            allowed_contexts=app_commands.AppCommandContext(guild=True, dm_channel=True, private_channel=True),
        )
        self.tree.add_command(self._commands())
        self.tree.on_error = self._on_error

    # --- the Bot interface discord_link.py uses --------------------------------

    @property
    def online(self) -> bool:
        return self.is_ready() and not self.is_closed()

    @property
    def name(self) -> str | None:
        return self.user.name if self.user else None

    @property
    def install_url(self) -> str | None:
        if not self.application_id:
            return None
        return (
            f"https://discord.com/oauth2/authorize?client_id={self.application_id}"
            "&integration_type=1&scope=applications.commands"
        )

    async def _discord_user(self, discord_id: str) -> discord.User:
        return self.get_user(int(discord_id)) or await self.fetch_user(int(discord_id))

    async def send_notes(self, discord_id: str, notes: list[Note], more: int) -> bool:
        try:
            user = await self._discord_user(discord_id)
            await user.send(
                content=f"…and {more} more on Nightcord." if more else None,
                embeds=[note_embed(n) for n in notes],
            )
        except (discord.Forbidden, discord.NotFound):
            return False
        return True

    async def fetch_profile(self, discord_id: str) -> DiscordProfile | None:
        try:
            user = await self.fetch_user(int(discord_id))  # fetch, not get: only this has the banner
        except discord.NotFound:
            return None
        return DiscordProfile(
            username=user.name,
            display_name=user.global_name or user.name,
            avatar=_image(user.avatar, AVATAR_SIZE),
            banner=_image(user.banner, BANNER_SIZE),
        )

    # --- lifecycle ------------------------------------------------------------

    async def setup_hook(self) -> None:
        synced = await self.tree.sync()
        log.info("Discord: registered %d slash command(s)", len(synced))

    async def on_ready(self) -> None:
        log.info("Discord: logged in as %s; add it to your account at %s", self.user, self.install_url)

    async def _on_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        original = getattr(error, "original", error)
        if isinstance(original, LinkError):
            await _say(interaction, original.message)
            return
        log.error("Discord command failed", exc_info=original)
        try:
            await _say(interaction, "Something went wrong on the Nightcord server. Try again in a bit.")
        except discord.HTTPException:
            pass

    # --- /nightcord -----------------------------------------------------------

    def _commands(self) -> app_commands.Group:
        link = self.link
        group = app_commands.Group(
            name="nightcord", description=f"Your account on the Nightcord server {link.server_name()}"[:100],
        )

        @group.command(name="link", description="Link your Nightcord account, using the code from Settings → Connections")
        @app_commands.describe(code="The code Nightcord showed you, like ABCD-EF23")
        async def link_(interaction: discord.Interaction, code: app_commands.Range[str, 1, 20]):
            user = await link.redeem(code, str(interaction.user.id), interaction.user.name)
            await _say(
                interaction,
                f"Linked! You're **{display_name(user)}** (@{user['username']}) on **{link.server_name()}**.\n"
                "I'll DM you about mentions, DMs, requests and announcements while you're away; "
                "change that with `/nightcord notifications`. `/nightcord sync` copies your Discord "
                "name, avatar and banner over.",
            )

        @group.command(name="account", description="Which Nightcord account your Discord account is linked to")
        async def account(interaction: discord.Interaction):
            user_id = link.user_for(str(interaction.user.id))
            user = link.db.public_user(user_id)
            s = link.view(user_id)
            embed = discord.Embed(title=display_name(user), description=f"@{user['username']}", color=BRAND)
            embed.add_field(name="Server", value=link.server_name(), inline=True)
            embed.add_field(name="Linked", value=f"<t:{int(_when(s['linked_at']).timestamp())}:R>", inline=True)
            on = [KIND_LABELS[k] for k in P.DISCORD_NOTIFY_KINDS if s["notify"][k]]
            embed.add_field(name="Notifications", value=", ".join(on) or "All off", inline=False)
            if s["dm_refused"]:
                embed.add_field(
                    name="⚠️ I couldn't DM you last time",
                    value="Keep me added to your account and allow DMs from apps, then try `/nightcord test`.",
                    inline=False,
                )
            await _say(interaction, embed=embed)

        @group.command(name="notifications", description="Choose what I DM you about")
        async def notifications(interaction: discord.Interaction):
            user_id = link.user_for(str(interaction.user.id))
            await _say(
                interaction, embed=notifications_embed(link, user_id),
                view=NotificationsView(link, user_id, interaction.user.id),
            )

        @group.command(name="sync", description="Make your Nightcord profile match your Discord one")
        @app_commands.describe(
            display_name="Copy your display name (default: yes)", avatar="Copy your avatar (default: yes)",
            banner="Copy your banner (default: yes)",
        )
        async def sync(interaction: discord.Interaction, display_name: bool = True, avatar: bool = True, banner: bool = True):
            user_id = link.user_for(str(interaction.user.id))
            fields = [f for f, on in (("display_name", display_name), ("avatar", avatar), ("banner", banner)) if on]
            if not fields:
                await _say(interaction, "Nothing to copy: you said no to everything.")
                return
            await interaction.response.defer(ephemeral=True, thinking=True)
            result = await link.sync_profile(user_id, fields)
            lines = []
            if result["synced"]:
                lines.append("Copied your " + ", ".join(SYNC_LABELS[f] for f in result["synced"]) + " to Nightcord.")
            for field, why in result["skipped"].items():
                lines.append(f"Skipped your {SYNC_LABELS[field]}: {why}")
            await _say(interaction, "\n".join(lines) or "Nothing changed.")

        @group.command(name="test", description="Send yourself a test notification")
        async def test(interaction: discord.Interaction):
            user_id = link.user_for(str(interaction.user.id))
            await interaction.response.defer(ephemeral=True)
            if await link.send_test(user_id):
                await _say(interaction, "Sent! Check your DMs with me.")
            else:
                await _say(
                    interaction,
                    "Discord wouldn't let me DM you. Keep me added to your account, and check "
                    "User Settings → Content & Social → allow DMs from apps (or share a server with me).",
                )

        @group.command(name="unlink", description="Unlink your Discord account from Nightcord")
        async def unlink(interaction: discord.Interaction):
            user_id = link.user_for(str(interaction.user.id))
            await link.unlink(user_id)
            await _say(interaction, f"Unlinked from **{link.server_name()}**. No more notifications from me.")

        return group


async def _run(bot: NightcordBot, token: str) -> None:
    try:
        await bot.start(token)
    except discord.LoginFailure:
        log.error("Discord rejected discord_token; the Discord link stays offline")
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("the Discord bot stopped")


def start(link: DiscordLink, token: str) -> tuple[NightcordBot, asyncio.Task]:
    """Logs the bot in in the background; returns it and the task running it."""
    bot = NightcordBot(link)
    link.bot = bot
    return bot, asyncio.create_task(_run(bot, token))


async def stop(bot: NightcordBot, task: asyncio.Task) -> None:
    await bot.close()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
