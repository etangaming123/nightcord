// Pictures for the preview's sample data, drawn as small SVGs so nothing has
// to be downloaded or shipped as image files. Each returns a data: URL.

const svg = (w, h, body) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
)}`;

const grad = (id, a, b, angle = 45) =>
  `<defs><linearGradient id="${id}" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`;

// --- avatars and guild icons -----------------------------------------------------------

const SHAPES = {
  moon: '<circle cx="64" cy="64" r="30" fill="#fff8e7"/><circle cx="78" cy="54" r="26" fill="url(#g)"/>',
  star: '<path d="M64 28l10 22 24 3-18 16 5 24-21-12-21 12 5-24-18-16 24-3z" fill="#fff8e7"/>',
  leaf: '<path d="M40 88c0-34 22-52 52-52 0 34-18 56-52 52z" fill="#e9ffe9"/><path d="M40 88l36-36" stroke="#2f6f4f" stroke-width="4"/>',
  wave: '<path d="M18 74c14-14 24-14 38 0s24 14 38 0 24-14 16-2" fill="none" stroke="#e8f6ff" stroke-width="10" stroke-linecap="round"/>',
  pixel: '<g fill="#fff">' + [[44, 44], [56, 44], [68, 44], [80, 44], [44, 56], [80, 56], [44, 68], [56, 68], [68, 68], [80, 68], [56, 80], [68, 80]]
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="10" height="10"/>`).join("") + "</g>",
  owl: '<circle cx="50" cy="60" r="14" fill="#fff"/><circle cx="78" cy="60" r="14" fill="#fff"/><circle cx="50" cy="60" r="6" fill="#241a33"/><circle cx="78" cy="60" r="6" fill="#241a33"/><path d="M58 76l6 8 6-8z" fill="#ffc861"/>',
  note: '<path d="M52 86V40l34-8v44" fill="none" stroke="#fff" stroke-width="7"/><circle cx="46" cy="88" r="10" fill="#fff"/><circle cx="80" cy="80" r="10" fill="#fff"/>',
  bolt: '<path d="M70 26L42 70h20l-6 32 30-46H66z" fill="#fff6c4"/>',
};

export function badgeArt(shape, a, b) {
  return svg(128, 128, `${grad("g", a, b)}<rect width="128" height="128" rx="64" fill="url(#g)"/>${SHAPES[shape] || ""}`);
}

export function iconArt(shape, a, b) {
  return svg(128, 128, `${grad("g", a, b)}<rect width="128" height="128" fill="url(#g)"/>${SHAPES[shape] || ""}`);
}

export function bannerArt(a, b, shape = "wave") {
  return svg(600, 240, `${grad("g", a, b, 20)}<rect width="600" height="240" fill="url(#g)"/><g transform="translate(420 40) scale(1.3)" opacity=".5">${SHAPES[shape] || ""}</g>`);
}

// --- custom emoji and stickers -----------------------------------------------------------

export const EMOJI_ART = {
  nightcord: () => svg(64, 64, '<circle cx="32" cy="32" r="30" fill="#2a1f3d"/><circle cx="28" cy="32" r="18" fill="#f5e6ff"/><circle cx="37" cy="26" r="16" fill="#2a1f3d"/><circle cx="46" cy="44" r="3" fill="#dda0ff"/>'),
  owl_wave: () => svg(64, 64, '<ellipse cx="32" cy="38" rx="22" ry="24" fill="#8a6bb3"/><circle cx="24" cy="30" r="9" fill="#fff"/><circle cx="40" cy="30" r="9" fill="#fff"/><circle cx="24" cy="30" r="4" fill="#222"/><circle cx="40" cy="30" r="4" fill="#222"/><path d="M29 40l3 5 3-5z" fill="#ffb347"/><g><animateTransform attributeName="transform" type="rotate" values="-20 52 40;20 52 40;-20 52 40" dur="1s" repeatCount="indefinite"/><ellipse cx="56" cy="36" rx="5" ry="10" fill="#6d5394"/></g>'),
  pixel_heart: () => svg(64, 64, '<g fill="#ff5c8a">' + [[12, 16], [20, 16], [36, 16], [44, 16], [4, 24], [12, 24], [20, 24], [28, 24], [36, 24], [44, 24], [52, 24], [4, 32], [12, 32], [20, 32], [28, 32], [36, 32], [44, 32], [52, 32], [12, 40], [20, 40], [28, 40], [36, 40], [44, 40], [20, 48], [28, 48], [36, 48], [28, 56]].map(([x, y]) => `<rect x="${x}" y="${y}" width="8" height="8"/>`).join("") + "</g>"),
  coffee: () => svg(64, 64, '<path d="M12 26h32v18a12 12 0 0 1-12 12h-8a12 12 0 0 1-12-12z" fill="#c98d5b"/><path d="M44 30h6a7 7 0 0 1 0 14h-6" fill="none" stroke="#c98d5b" stroke-width="5"/><path d="M22 8c-4 6 4 8 0 14M32 8c-4 6 4 8 0 14" stroke="#bbb" stroke-width="3" fill="none"/>'),
  sparkles: () => svg(64, 64, '<path d="M24 6l5 15 15 5-15 5-5 15-5-15-15-5 15-5z" fill="#ffd84d"/><path d="M48 34l3 9 9 3-9 3-3 9-3-9-9-3 9-3z" fill="#ffe98f"/>'),
  blobnod: () => svg(64, 64, '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 5;0 0" dur=".6s" repeatCount="indefinite"/><circle cx="32" cy="34" r="24" fill="#ffcc4d"/><circle cx="24" cy="30" r="3" fill="#333"/><circle cx="40" cy="30" r="3" fill="#333"/><path d="M24 42q8 6 16 0" stroke="#333" stroke-width="3" fill="none"/></g>'),
};

export const STICKER_ART = {
  good_night: () => svg(320, 320, `${grad("g", "#2b1d47", "#553a7f", 90)}<rect x="20" y="20" width="280" height="280" rx="60" fill="url(#g)"/><circle cx="140" cy="150" r="70" fill="#fff4d6"/><circle cx="175" cy="125" r="62" fill="#3c2961"/><g fill="#fff4d6"><circle cx="230" cy="90" r="5"/><circle cx="250" cy="160" r="3"/><circle cx="90" cy="80" r="4"/></g><text x="160" y="270" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">good night!</text>`),
  owl_hi: () => svg(320, 320, '<ellipse cx="160" cy="180" rx="110" ry="120" fill="#8a6bb3"/><circle cx="118" cy="150" r="40" fill="#fff"/><circle cx="202" cy="150" r="40" fill="#fff"/><circle cx="118" cy="150" r="18" fill="#222"/><circle cx="202" cy="150" r="18" fill="#222"/><path d="M148 196l12 20 12-20z" fill="#ffb347"/><text x="160" y="300" font-family="sans-serif" font-size="40" font-weight="800" fill="#fff" stroke="#553a7f" stroke-width="3" paint-order="stroke" text-anchor="middle">hi!!</text>'),
  ship_it: () => svg(320, 320, '<rect x="30" y="60" width="260" height="200" rx="28" fill="#1f8b4c"/><path d="M90 170l40 40 100-100" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/><text x="160" y="300" font-family="sans-serif" font-size="36" font-weight="800" fill="#1f8b4c" text-anchor="middle">ship it</text>'),
};

// --- link previews and attachments ---------------------------------------------------------

export function videoThumb(title, a = "#1b1b1f", b = "#3a0d0d") {
  return svg(480, 270, `${grad("g", a, b, 30)}<rect width="480" height="270" fill="url(#g)"/>`
    + '<g opacity=".25" fill="#fff"><circle cx="90" cy="70" r="40"/><circle cx="400" cy="210" r="60"/></g>'
    + `<text x="24" y="240" font-family="sans-serif" font-size="26" font-weight="800" fill="#fff">${title}</text>`
    + '<rect x="200" y="100" width="80" height="56" rx="16" fill="#e62117"/><path d="M230 114l24 14-24 14z" fill="#fff"/>');
}

export function articleThumb(a, b) {
  return svg(160, 160, `${grad("g", a, b)}<rect width="160" height="160" fill="url(#g)"/><g fill="#fff" opacity=".85"><rect x="24" y="36" width="112" height="10" rx="5"/><rect x="24" y="58" width="90" height="10" rx="5"/><rect x="24" y="80" width="104" height="10" rx="5"/><rect x="24" y="102" width="70" height="10" rx="5"/></g>`);
}

// An "animated GIF" link: an animated SVG plays like one.
export function bouncingGif() {
  return svg(320, 240, '<rect width="320" height="240" fill="#1d1830"/><g fill="#ffd84d"><circle cx="160" cy="80" r="26"><animate attributeName="cy" values="70;170;70" dur="1s" repeatCount="indefinite" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1"/></circle></g><rect x="60" y="200" width="200" height="6" rx="3" fill="#6d5394"/>');
}

export function sunsetPhoto() {
  return svg(800, 500, `${grad("sky", "#ff9a5a", "#5b2a86", 90)}<rect width="800" height="500" fill="url(#sky)"/><circle cx="400" cy="320" r="90" fill="#ffd27a"/><path d="M0 330q200-60 400 0t400 0v170H0z" fill="#2b1846"/><path d="M0 380q200-40 400 0t400 0v120H0z" fill="#1a0f2e"/>`);
}

export function pixelScene() {
  const cells = [];
  const colors = ["#2b1d47", "#553a7f", "#8a6bb3", "#dda0ff", "#ffd84d"];
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 16; x++) {
      const c = y > 8 ? 0 : y > 6 && (x + y) % 5 === 0 ? 1 : (x * 7 + y * 3) % 23 === 0 ? 4 : y < 3 ? 2 : 1;
      cells.push(`<rect x="${x * 20}" y="${y * 20}" width="20" height="20" fill="${colors[c]}"/>`);
    }
  }
  return svg(320, 240, cells.join(""));
}

export const textFile = (text) => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
