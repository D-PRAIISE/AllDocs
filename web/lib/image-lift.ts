"use client";

/**
 * Background removal for lifted signatures / stamps.
 *
 * A signature or stamp lifted off a document page comes with the paper
 * behind it. To paste it cleanly onto another page (or another document)
 * the paper must become transparent while the ink survives — including
 * its anti-aliased edges.
 *
 * Approach (pure client-side canvas, no server round-trip):
 *   1. Estimate the background colour from the border ring of the image
 *      (the modal quantized colour — a lifted region's border is nearly
 *      always paper, not ink).
 *   2. Alpha per pixel by colour distance to that background:
 *      close = fully transparent, far = untouched, with a linear ramp
 *      between the two thresholds so glyph edges fade smoothly instead
 *      of aliasing into a hard halo.
 */

export interface LiftedImage {
  dataUrl: string; // PNG with alpha
  width: number;
  height: number;
}

// Colour distance below NEAR is definitely background; above FAR is
// definitely ink. Between the two, alpha ramps linearly. Tuned on
// scanned-paper signatures: paper noise stays under ~35, pen ink and
// stamp pigment sit well above 90.
const NEAR = 40;
const FAR = 95;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

/** Estimate background as the modal (quantized) colour of the border ring. */
function estimateBackground(
  d: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] {
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.03));
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // 16-level buckets per channel — coarse enough to merge paper noise.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    counts.set(key, e);
  };
  for (let x = 0; x < w; x++) {
    for (let t = 0; t < ring; t++) {
      sample(x, t);
      sample(x, h - 1 - t);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let t = 0; t < ring; t++) {
      sample(t, y);
      sample(w - 1 - t, y);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  if (!best) return [255, 255, 255];
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

/**
 * Make the background of an image transparent. Returns a PNG data URL.
 * The input is any browser-decodable image / data URL.
 */
export async function removeBackground(src: string): Promise<LiftedImage> {
  const img = await loadImage(src);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w < 2 || h < 2) throw new Error("region too small");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;

  const [br, bg, bb] = estimateBackground(d, w, h);
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - br;
    const dg = d[i + 1] - bg;
    const db = d[i + 2] - bb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= NEAR) {
      d[i + 3] = 0;
    } else if (dist < FAR) {
      d[i + 3] = Math.round((d[i + 3] * (dist - NEAR)) / (FAR - NEAR));
    }
  }
  ctx.putImageData(id, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), width: w, height: h };
}
