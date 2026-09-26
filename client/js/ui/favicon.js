// The tab icon gets a red badge with how many mentions (and DMs) are waiting,
// like Discord's. Drawn on a canvas over the logo; 0 puts the plain logo back.

const SIZE = 64;
let plain = null; // the page's own icon URL
let logo = null; // it, loaded as an image to draw from
let shown = 0;

export function setFaviconBadge(count) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link || count === shown) return;
  plain ??= link.href;
  shown = count;
  if (!count) { link.href = plain; return; }
  if (!logo) { logo = new Image(); logo.src = plain; }
  const draw = () => {
    if (shown !== count) return; // the count moved on while the logo loaded
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(logo, 0, 0, SIZE, SIZE);
    const label = count > 9 ? "9+" : String(count);
    const r = 17;
    const x = SIZE - r - 1;
    const y = SIZE - r - 1;
    // A ring of transparency around the badge keeps it apart from the logo.
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#f23f43";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${label.length > 1 ? 20 : 26}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 2);
    try {
      link.href = canvas.toDataURL("image/png");
    } catch {
      // A logo from somewhere that taints the canvas: leave the plain icon.
    }
  };
  if (logo.complete && logo.naturalWidth) draw();
  else logo.addEventListener("load", draw, { once: true });
}
