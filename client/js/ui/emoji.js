// Emoji picker: custom emoji from every guild you're in (usable anywhere,
// PROTOCOL.md §5 Emoji and stickers) plus common unicode emoji with search
// keywords. Picks are a unicode string or a custom token <:name:id>.

import { CUSTOM_EMOJI, emojiToken, emojiUrl, usableEmojiById, usableEmojiGroups } from "../perks.js";
import { getPrefs, noteEmojiUse } from "../prefs.js";
import { add, clear, h, imageUrl, initials } from "./dom.js";
import { closePopover, openPopover } from "./modals.js";

// "emoji keywords…", grouped.
const GROUPS = [
  ["Smileys", `😀 grin smile happy|😃 smile happy|😄 smile laugh|😁 grin beam|😆 laugh xd|😅 sweat laugh|🤣 rofl laugh floor|😂 joy tears laugh lol|🙂 slight smile|🙃 upside down|😉 wink|😊 blush smile|😇 innocent halo angel|🥰 love hearts|😍 heart eyes love|🤩 star struck wow|😘 kiss|😋 yum tasty|😛 tongue|😜 wink tongue|🤪 zany crazy|😝 tongue squint|🤑 money|🤗 hug|🤭 oops giggle|🤫 shush quiet|🤔 think hmm|🤐 zipper mouth|🤨 raised eyebrow sus|😐 neutral|😑 expressionless|😶 no mouth|😏 smirk|😒 unamused|🙄 eye roll|😬 grimace|😌 relieved|😔 pensive sad|😪 sleepy|🤤 drool|😴 sleep zzz|😷 mask sick|🤒 thermometer sick|🤕 hurt bandage|🤢 nauseated sick|🤮 vomit|🥵 hot|🥶 cold freezing|🥴 woozy drunk|😵 dizzy|🤯 mind blown|🤠 cowboy|🥳 party celebrate|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 frown|😮 open mouth wow|😯 hushed|😲 astonished shocked|😳 flushed|🥺 pleading puppy eyes|😦 frowning|😧 anguished|😨 fearful|😰 anxious sweat|😥 sad relieved|😢 cry sad tear|😭 sob crying|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 downcast sweat|😩 weary|😫 tired|🥱 yawn|😤 triumph huff|😡 angry rage|😠 angry mad|🤬 cursing swear|😈 devil smiling|👿 imp devil|💀 skull dead|☠️ skull crossbones|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot|😺 cat smile|😹 cat joy|😻 cat heart eyes`],
  ["People", `👋 wave hello hi bye|🤚 raised back hand|✋ hand stop high five|🖖 vulcan|👌 ok okay|🤌 pinched fingers|✌️ peace victory|🤞 fingers crossed luck|🤟 love you|🤘 rock horns|🤙 call me shaka|👈 point left|👉 point right|👆 point up|👇 point down|☝️ index up|👍 thumbs up yes like +1|👎 thumbs down no dislike -1|✊ fist|👊 punch fist bump|👏 clap applause|🙌 raised hands hooray|👐 open hands|🤲 palms up|🤝 handshake deal|🙏 pray please thanks|✍️ write|💪 muscle strong flex|🧠 brain smart|👀 eyes look see|👁️ eye|👅 tongue|👄 lips|🫡 salute|🫶 heart hands|🤷 shrug idk|🤦 facepalm|🙋 raise hand|🙇 bow|💁 info|🙆 ok gesture|🙅 no gesture|🧑‍💻 technologist coder|🕺 dance|💃 dancer|🏃 run|🚶 walk`],
  ["Hearts", `❤️ heart love red|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid arrow|💝 heart ribbon gift|💯 hundred 100 perfect|💢 anger|💥 boom collision|💫 dizzy star|💦 sweat drops|💨 dash wind|💬 speech bubble|💭 thought bubble|💤 zzz sleep`],
  ["Nature", `🐶 dog puppy|🐱 cat kitty|🐭 mouse|🐹 hamster|🐰 rabbit bunny|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🙈 see no evil|🙉 hear no evil|🙊 speak no evil|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦉 owl|🦇 bat|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🐙 octopus|🦀 crab|🐟 fish|🐬 dolphin|🐳 whale|🦈 shark|🌸 blossom flower|🌹 rose|🌻 sunflower|🌷 tulip|🌱 seedling plant|🌲 tree evergreen|🌵 cactus|🍀 clover luck|🍁 maple leaf|🍄 mushroom|🌍 earth globe world|🌙 moon crescent night|⭐ star|🌟 glowing star|✨ sparkles|⚡ zap lightning|🔥 fire lit hot|🌈 rainbow|☀️ sun sunny|🌧️ rain|❄️ snowflake cold|🌊 wave ocean`],
  ["Food", `🍎 apple|🍊 orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥑 avocado|🍅 tomato|🌶️ pepper hot|🌽 corn|🥕 carrot|🥔 potato|🍞 bread|🥐 croissant|🧀 cheese|🥚 egg|🍳 cooking egg|🥞 pancakes|🥓 bacon|🍔 burger|🍟 fries|🍕 pizza|🌭 hotdog|🌮 taco|🌯 burrito|🍜 ramen noodles|🍝 spaghetti pasta|🍣 sushi|🍱 bento|🍙 rice ball|🍦 ice cream|🍩 donut|🍪 cookie|🎂 birthday cake|🍰 cake|🧁 cupcake|🍫 chocolate|🍬 candy|🍿 popcorn|☕ coffee|🍵 tea|🧋 boba bubble tea|🥤 cup drink|🍺 beer|🍻 cheers beers|🍷 wine|🍸 cocktail|🥂 champagne toast`],
  ["Activities", `⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🎱 8ball pool|🏓 ping pong|🏸 badminton|🥊 boxing|🎯 target bullseye dart|🎮 video game controller|🕹️ joystick|🎲 dice|🧩 puzzle|♟️ chess|🎨 art palette|🎬 movie clapper|🎤 microphone sing|🎧 headphones music|🎸 guitar|🎹 piano|🥁 drum|🎺 trumpet|🎻 violin|🏆 trophy win|🥇 gold medal first|🥈 silver medal|🥉 bronze medal|🎉 tada party celebrate|🎊 confetti|🎁 gift present|🎈 balloon|🎄 christmas tree|🎃 pumpkin halloween|🎆 fireworks`],
  ["Objects", `💻 laptop computer|🖥️ desktop|⌨️ keyboard|🖱️ mouse|📱 phone mobile|☎️ telephone|📷 camera|📺 tv|💡 bulb idea|🔦 flashlight|📚 books|📖 book|📝 memo note|✏️ pencil|📌 pin|📎 paperclip|🔗 link|📅 calendar|⏰ alarm clock|⌛ hourglass|💰 money bag|💸 money wings|💳 card|🔑 key|🔒 lock|🔓 unlock|🛠️ tools|🔧 wrench|🔨 hammer|⚙️ gear settings|🧪 test tube|🔬 microscope|💊 pill|🩹 bandage|🚀 rocket launch ship|✈️ plane|🚗 car|🚲 bike|⛵ boat|🏠 house home|🏢 office|⛺ tent camping|🗺️ map|🧭 compass|📦 package box|🛒 cart|🔔 bell|📣 megaphone|📢 loudspeaker`],
  ["Symbols", `✅ check yes done|☑️ ballot check|✔️ check mark|❌ cross x no|❎ cross button|➕ plus|➖ minus|❓ question|❗ exclamation|‼️ double exclamation|⁉️ interrobang|⚠️ warning|🚫 prohibited no|⛔ no entry|🆗 ok button|🆕 new|🆒 cool button|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|⬆️ up arrow|⬇️ down arrow|⬅️ left arrow|➡️ right arrow|🔁 repeat|🔄 refresh|▶️ play|⏸️ pause|⏹️ stop|♻️ recycle|™️ trademark|©️ copyright|#️⃣ hash|0️⃣ zero|1️⃣ one|2️⃣ two|3️⃣ three|4️⃣ four|5️⃣ five|🔟 ten|🏳️‍🌈 rainbow flag pride|🏁 checkered flag finish`],
];

const ALL = GROUPS.map(([name, list]) => [name, list.split("|").map((entry) => {
  const [emoji, ...words] = entry.split(" ");
  return { emoji, words: words.join(" ") };
})]);

const GROUP_ICONS = { Smileys: "😀", People: "👋", Hearts: "❤️", Nature: "🌿", Food: "🍕", Activities: "⚽", Objects: "💡", Symbols: "🔣" };

// Every unicode emoji with its keywords, for :name autocomplete.
export const UNICODE_EMOJI = ALL.flatMap(([, list]) => list);

// The custom emoji behind a picked value, or null for unicode.
export function customOf(value) {
  const m = CUSTOM_EMOJI.exec(value || "");
  return m ? { animated: m[1] === "a", name: m[2], emoji_id: m[3] } : null;
}

// An emoji as shown in pickers, reactions and autocomplete.
export function emojiGlyph(value, { cls = "" } = {}) {
  const c = customOf(value);
  if (!c) return h("span", { class: `emoji ${cls}` }, value);
  const img = h("img", { class: `cemoji ${cls}`, src: emojiUrl(c.emoji_id), alt: `:${c.name}:`, draggable: "false", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(h("span", { class: `emoji ${cls}` }, `:${c.name}:`)));
  return img;
}

// Opens the picker next to anchor; onPick(value) is called once.
export function openEmojiPicker(anchor, onPick, { placement = "top", custom = true } = {}) {
  const search = h("input", { type: "search", placeholder: "Search emoji", "aria-label": "Search emoji", class: "emoji-search" });
  const grid = h("div", { class: "emoji-grid" });
  const tabs = h("div", { class: "emoji-tabs", role: "tablist", "aria-label": "Emoji categories" });
  const preview = h("div", { class: "emoji-preview muted small" }, "Pick an emoji");
  const pick = (value) => {
    noteEmojiUse(value);
    closePopover();
    onPick(value);
  };
  const hover = (glyph, label) => clear(preview, glyph, h("span", {}, label));
  const cell = (e) => h("button", {
    class: "emoji-cell", type: "button", title: e.words ? `:${e.words.split(" ")[0]}:` : e.emoji, "aria-label": e.words || e.emoji,
    on: { click: () => pick(e.emoji), mouseenter: () => hover(h("span", { class: "emoji big" }, e.emoji), e.words ? `:${e.words.split(" ")[0]}:` : e.emoji) },
  }, e.emoji);
  const customCell = (e, guildName) => h("button", {
    class: "emoji-cell custom", type: "button", title: `:${e.name}:`, "aria-label": `:${e.name}: from ${guildName}`,
    on: { click: () => pick(emojiToken(e)), mouseenter: () => hover(emojiGlyph(emojiToken(e), { cls: "big" }), `:${e.name}: — ${guildName}`) },
  }, emojiGlyph(emojiToken(e)));
  const groups = custom ? usableEmojiGroups() : [];
  const section = (id, label) => h("div", { class: "emoji-group", id }, label);
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^:|:$/g, "");
    clear(grid);
    tabs.hidden = !!q;
    if (q) {
      const customHits = groups.flatMap(({ guild, emojis }) => emojis.filter((e) => e.name.toLowerCase().includes(q)).map((e) => customCell(e, guild.name)));
      const hits = ALL.flatMap(([, list]) => list).filter((e) => e.words.includes(q));
      if (!hits.length && !customHits.length) add(grid, h("p", { class: "muted small emoji-empty" }, "No emoji found"));
      add(grid, ...customHits, ...hits.map(cell));
      return;
    }
    const recent = getPrefs().frequentEmoji.filter((v) => {
      const c = customOf(v);
      return !c || (custom && usableEmojiById(c.emoji_id));
    });
    if (recent.length) {
      add(grid, section("emoji-sec-recent", "Frequently used"), ...recent.map((v) => {
        const c = customOf(v);
        return c ? customCell(usableEmojiById(c.emoji_id), "") : cell({ emoji: v, words: "" });
      }));
    }
    for (const { guild, emojis } of groups) {
      add(grid, section(`emoji-sec-${guild.guild_id}`, guild.name), ...emojis.map((e) => customCell(e, guild.name)));
    }
    ALL.forEach(([name, list], i) => add(grid, section(`emoji-sec-u${i}`, name), ...list.map(cell)));
  };
  const tab = (id, label, glyph) => h("button", {
    class: "emoji-tab", type: "button", title: label, "aria-label": label,
    on: { click: () => grid.querySelector(`#${id}`)?.scrollIntoView({ block: "start" }) },
  }, glyph);
  add(tabs,
    getPrefs().frequentEmoji.length ? tab("emoji-sec-recent", "Frequently used", "🕘") : null,
    groups.map(({ guild }) => tab(`emoji-sec-${guild.guild_id}`, guild.name,
      guild.icon_id ? h("img", { src: imageUrl(guild.icon_id), alt: "", draggable: "false" }) : h("span", { class: "tab-initials" }, initials(guild.name)))),
    ALL.map(([name], i) => tab(`emoji-sec-u${i}`, name, GROUP_ICONS[name] || "•")));
  search.addEventListener("input", draw);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      grid.querySelector(".emoji-cell")?.click();
    }
  });
  draw();
  const el = openPopover(anchor, h("div", { class: "emoji-picker" }, search, h("div", { class: "emoji-body" }, tabs, grid), preview), { placement, cls: "emoji-pop" });
  search.focus();
  return el;
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];
