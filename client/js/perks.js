// Customisation perks (PROTOCOL.md §8d) and the custom emoji / sticker
// index built from every guild the user is in (§4 Emoji, Sticker).
//
// The server enforces perks when something is set; this module decides what
// to *show*, so switching a feature off hides stored cosmetics at once.

import { memberById, state, userById } from "./state.js";
import { mediaUrl, setAnimatePolicy } from "./ui/dom.js";

const GUILD_FEATURES = new Set(["guild_banner", "gradient_roles", "role_icons"]);

function entitled(user) {
  const mode = state.info?.customization_mode ?? "on";
  if (mode === "on") return true;
  if (mode === "off" || !user) return false;
  return !!user.perks || (user.server_role && user.server_role !== "none") || !!user.is_server_owner;
}

const featureEnabled = (feature) => state.info?.customization_features?.[feature] !== false;

// A personal feature for a user (defaults to me).
export function userCan(feature, user = state.user) {
  const fresh = (user && userById(user.user_id)) || user;
  return featureEnabled(feature) && entitled(fresh);
}

// A guild feature: follows the guild's owner, like a boosted server.
export function guildCan(feature, guild) {
  if (!guild || !featureEnabled(feature)) return false;
  const owner = userById(guild.owner_user_id) || (guild.guild_id === state.guildId ? memberById(guild.owner_user_id)?.user : null);
  // Unknown owner (members not loaded yet): only "on" mode is certain.
  if (!owner) return (state.info?.customization_mode ?? "on") === "on";
  return entitled(owner);
}

export const can = (feature, subject) => (GUILD_FEATURES.has(feature) ? guildCan(feature, subject) : userCan(feature, subject));

// Animated avatars/icons play when the owner of the image may use animated media.
setAnimatePolicy((owner) => (owner?.owner_user_id ? guildCan("animated_media", owner) : userCan("animated_media", owner)));

// --- custom emoji and stickers --------------------------------------------------

export const emojiUrl = (id) => mediaUrl(id);
export const stickerUrl = (id) => mediaUrl(id);
export const emojiToken = (e) => `<${e.animated ? "a" : ""}:${e.name}:${e.emoji_id}>`;
export const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$/;

// Guilds whose emoji and stickers I can use: visible (non-ghost) memberships,
// the current guild first.
function usableGuilds() {
  const list = [...state.guilds.values()].filter((g) => !g.ghost);
  return list.sort((a, b) => (a.guild_id === state.guildId ? -1 : b.guild_id === state.guildId ? 1 : 0));
}

export function usableEmojiGroups() {
  return usableGuilds().filter((g) => g.emojis?.length).map((g) => ({ guild: g, emojis: g.emojis }));
}

export function usableStickerGroups() {
  return usableGuilds().filter((g) => g.stickers?.length).map((g) => ({ guild: g, stickers: g.stickers }));
}

// Any emoji I know of (including ghost guilds'), for rendering.
export function emojiById(id) {
  for (const g of state.guilds.values()) {
    const e = g.emojis?.find((x) => x.emoji_id === id);
    if (e) return { ...e, guildName: g.name };
  }
  return null;
}

export function usableEmojiById(id) {
  for (const g of usableGuilds()) {
    const e = g.emojis?.find((x) => x.emoji_id === id);
    if (e) return e;
  }
  return null;
}

// ":name:" -> the emoji I can use with that name (current guild first).
export function emojiByName(name) {
  const lower = name.toLowerCase();
  for (const g of usableGuilds()) {
    const e = g.emojis?.find((x) => x.name.toLowerCase() === lower);
    if (e) return e;
  }
  return null;
}

export function searchEmojis(query, limit = 40) {
  const q = query.toLowerCase();
  const out = [];
  for (const { guild, emojis } of usableEmojiGroups()) {
    for (const e of emojis) if (e.name.toLowerCase().includes(q)) out.push({ ...e, guildName: guild.name });
  }
  out.sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1));
  return out.slice(0, limit);
}

// How a member's name looks in the current guild: their top coloured role's
// colour or gradient, and their top role icon (PROTOCOL.md §4 Role).
export function roleDisplay(userId) {
  const guild = state.view === "guild" ? state.guilds.get(state.guildId) : null;
  const member = guild ? memberById(userId) : null;
  if (!member) return { color: null, gradient: null, icon: null };
  const ids = new Set(member.role_ids);
  const roles = state.roles.filter((r) => ids.has(r.role_id));
  const colored = roles.find((r) => r.color);
  const gradient = colored?.colors?.length > 1 && guildCan("gradient_roles", guild) ? colored.colors : null;
  const iconRole = guildCan("role_icons", guild) ? roles.find((r) => r.icon_id || r.icon_emoji) : null;
  return {
    color: colored?.color || null,
    gradient,
    icon: iconRole ? { role: iconRole, icon_id: iconRole.icon_id, emoji: iconRole.icon_emoji } : null,
  };
}

// Why a personal feature isn't available to me, or null if it is.
export function lockedReason(feature) {
  if (userCan(feature)) return null;
  if (state.info?.customization_features?.[feature] === false) return "The server owner has turned this off.";
  if (state.info?.customization_mode === "off") return "Customisation is turned off on this server.";
  return "On this server, only people with perks can use this — ask a server admin.";
}
