import { type FixedContent, type Length, lengthToPx } from "@/lib/udm";

// Baseline→top ratio: converts a text run's baseline y into the top of
// its highlight box. Matches the editor/exporter text positioning.
const BASELINE_TO_TOP = 0.8;
// Points from a Length (px is 96 DPI, pt is 72 DPI).
const lengthToPt = (len: Length): number => lengthToPx(len) * (72 / 96);

export interface SearchMatch {
  pageIdx: number;
  layerIdx: number;
  runIdx: number;
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
}

/** Stable per-match key (page:layer:run) for identifying the active match. */
export function matchKey(m: SearchMatch): string {
  return `${m.pageIdx}:${m.layerIdx}:${m.runIdx}`;
}

/**
 * Case-insensitive substring search across every text run of a fixed-mode
 * document. Returns a highlight rectangle (in scaled px) per match.
 * Shared by the read-only viewer (DOM overlays) and the editor (canvas).
 */
export function findTextMatches(
  fixed: FixedContent,
  query: string,
  scale: number,
): SearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchMatch[] = [];
  fixed.pages.forEach((page, pageIdx) => {
    page.layers.forEach((layer, layerIdx) => {
      if (layer.type !== "text") return;
      layer.runs.forEach((run, runIdx) => {
        if (!run.text.toLowerCase().includes(q)) return;
        const fontSizePx = lengthToPx(run.font_size) * scale;
        const xPx = lengthToPx(run.x) * scale;
        const yPx = lengthToPx(run.y) * scale;
        // OCR runs carry a measured width; everything else uses a glyph
        // approximation. Highlighting is a guide, not a measurement.
        const widthPt =
          run._meta?.ocr_width ?? run.text.length * lengthToPt(run.font_size) * 0.5;
        const wPx = widthPt * (96 / 72) * scale;
        const top = yPx - fontSizePx * BASELINE_TO_TOP;
        out.push({ pageIdx, layerIdx, runIdx, xPx, yPx: top, wPx, hPx: fontSizePx });
      });
    });
  });
  return out;
}
