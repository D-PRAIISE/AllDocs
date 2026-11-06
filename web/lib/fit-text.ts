"use client";

import { useEffect, useState } from "react";

/**
 * Fitting rendered text to the width it had on the source page.
 *
 * A fixed-mode page is drawn as absolutely-positioned runs, each pinned
 * to the x the PDF recorded. The glyphs, though, are redrawn with a CSS
 * font whose advance widths almost never match the embedded one. Every
 * run therefore starts in the right place and ends in the wrong one:
 * where the substitute is wider it overruns its neighbour, where it's
 * narrower a gap opens. On a real certificate that showed up as
 * "GRACEFE" (a space swallowed) and "FE MALE" (a gap inside a word).
 *
 * Merging a line's fragments removes most of the seams, but it can't
 * help where the fragments genuinely differ in style, and it does
 * nothing about a line simply rendering narrower than the original.
 * Pinning each run to its recorded width does both.
 */

/** Shared offscreen 2D context. measureText is synchronous and never
 *  touches layout, so a page's worth of runs can be measured during
 *  render — a per-span DOM measurement would force a reflow each time. */
let cachedCtx: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | null {
  if (cachedCtx !== undefined) return cachedCtx;
  if (typeof document === "undefined") return (cachedCtx = null);
  cachedCtx = document.createElement("canvas").getContext("2d");
  return cachedCtx;
}

/**
 * Width `text` occupies when drawn in `fontCss`, in CSS pixels. 0 when
 * there's nothing to measure or no canvas to measure with.
 */
export function measureTextPx(text: string, fontCss: string): number {
  if (!text) return 0;
  const ctx = measureCtx();
  if (!ctx) return 0;
  ctx.font = fontCss;
  const w = ctx.measureText(text).width;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * Horizontal scale that makes `text` occupy exactly `targetPx` when drawn
 * in `fontCss` (a CSS shorthand: "italic 700 14px Inter, sans-serif").
 * Returns 1 when there is nothing to fit, nothing to measure with, or the
 * correction isn't worth making.
 */
export function fitScaleX(text: string, targetPx: number, fontCss: string): number {
  if (targetPx <= 0 || !text || !text.trim()) return 1;
  const natural = measureTextPx(text, fontCss);
  if (!natural) return 1;

  const scale = targetPx / natural;
  // A bad measurement should leave the glyphs alone, not smear them
  // across the page. Anything this far out means the font match failed
  // or the recorded width is wrong, and squashing to fit would look far
  // worse than the overlap it was trying to cure.
  if (scale < 0.5 || scale > 2) return 1;
  // Sub-2% corrections cost subpixel antialiasing and buy nothing.
  return Math.abs(scale - 1) < 0.02 ? 1 : scale;
}

/** CSS `font` shorthand in the order the spec requires. */
export function fontShorthand(
  style: string,
  weight: number | string,
  sizePx: number,
  family: string
): string {
  return `${style || "normal"} ${weight || 400} ${sizePx}px ${family || "sans-serif"}`;
}

/**
 * Flips true once webfonts have finished loading.
 *
 * Measurements taken before then are against a fallback face and will be
 * wrong; consuming components re-render when this changes so every run
 * gets re-measured against the face it's actually drawn in.
 */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) {
      setReady(true);
      return;
    }
    let alive = true;
    fonts.ready.then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}
