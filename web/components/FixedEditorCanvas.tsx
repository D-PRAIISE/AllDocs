"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Image as KonvaImage, Layer, Line as KonvaLine, Path as KonvaPath, Rect as KonvaRect, Stage, Text as KonvaText } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Stage as KonvaStageType } from "konva/lib/Stage";
import useImage from "use-image";

import { ZoomControl } from "./ZoomControl";

import {
  type ColorRef,
  type Document,
  type FixedContent,
  type FontResource,
  type ImageLayer as UdmImageLayer,
  type Length,
  type Page,
  type PositionedTextRun,
  type ShapeLayer as UdmShapeLayer,
  type TextLayer as UdmTextLayer,
  colorRefToCss,
  lengthToPx,
  sourceWidthPx,
} from "@/lib/udm";
import { fitScaleForWidth, useIsMobile, useKeyboardInset } from "@/lib/use-is-mobile";
import { fitScaleX, measureTextPx, useFontsReady } from "@/lib/fit-text";
import { usePinchZoom } from "@/lib/use-pinch-zoom";
import { findTextMatches } from "@/lib/text-search";
import { cssFontStack } from "@/lib/font-css";
import { removeBackground } from "@/lib/image-lift";
import { SearchBar } from "./SearchBar";

type FamilyClass = "sans" | "serif" | "mono";

/** The one active editor tool. "none" = plain click-to-edit text.
 * "select" = arrow tool for clicking any image/shape to select + resize. */
type EditorMode =
  | "none"
  | "select"
  | "region-image"
  | "recolor"
  | "add-text"
  | "add-image"
  | "add-rect"
  | "highlight"
  | "comment"
  | "ink"
  | "add-field-text"
  | "add-field-checkbox"
  | "add-field-radio"
  | "lift-region";

/** What a text edit commits: the new string plus its formatting. */
interface EditCommit {
  text: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  family: FamilyClass;
  /** #rrggbb text colour. */
  colorHex: string;
  /** 0–100 text opacity. */
  opacityPct: number;
}

const FAMILY_NAME: Record<FamilyClass, string> = {
  sans: "sans-serif",
  serif: "serif",
  mono: "monospace",
};

// Used by the text-edit overlay (contenteditable). Leads with the bundled
// metric-compatible clone so what you type while editing matches what the
// canvas renders. Keep in sync with lib/font-css.ts.
const FAMILY_CSS: Record<FamilyClass, string> = {
  sans: '"AllDocs Sans", ui-sans-serif, system-ui, sans-serif',
  serif: '"AllDocs Serif", ui-serif, Georgia, serif',
  mono: '"AllDocs Mono", ui-monospace, monospace',
};

/** Best-effort read of a run colour into a #rrggbb hex + opacity %. */
function colorToHexAlpha(color: ColorRef | undefined): { hex: string; alphaPct: number } {
  const lit = color?.literal;
  if (lit?.kind === "rgb") {
    const h = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return {
      hex: `#${h(lit.r)}${h(lit.g)}${h(lit.b)}`,
      alphaPct: lit.a !== undefined ? Math.round((lit.a / 255) * 100) : 100,
    };
  }
  if (lit?.kind === "hex") {
    const raw = lit.hex.replace("#", "").slice(0, 6).padEnd(6, "0");
    return { hex: `#${raw}`, alphaPct: 100 };
  }
  return { hex: "#111111", alphaPct: 100 };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 17, g: 17, b: 17 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Common document text colours. Buttons (not a native <input type=color>)
// so picking one doesn't blur+commit the contentEditable mid-edit.
const TEXT_COLORS = [
  "#000000", "#3a3a3a", "#888888", "#c0392b",
  "#c2410c", "#15803d", "#2563eb", "#7c3aed",
];

/** UDM Length -> PDF points. */
function lengthToPt(len: Length): number {
  return len.unit === "pt" ? len.value : (lengthToPx(len) * 72) / 96;
}

/** Classify a FontResource into sans / serif / mono — mirrors the
 * Python classify_family (sans wins over the "serif" substring). */
function familyClassOf(font: FontResource | undefined): FamilyClass {
  const f = (font?.family ?? "").toLowerCase();
  if (/mono|courier|consol|menlo|monaco/.test(f)) return "mono";
  if (f.includes("sans")) return "sans";
  if (/serif|times|georgia|garamond|cambria/.test(f)) return "serif";
  return "sans";
}

/** Find or create a substituted FontResource for (family, weight, style)
 * on a mutable doc clone. Returns its id. */
function ensureFont(
  doc: Document,
  family: FamilyClass,
  weight: number,
  style: "normal" | "italic" = "normal",
): string {
  const familyName = FAMILY_NAME[family];
  const existing = doc.resources.fonts.find(
    (f) => f.family === familyName && f.weight === weight && f.style === style
  );
  if (existing) return existing.id;
  const id = `font_user_${family}_${weight}_${style}`;
  if (!doc.resources.fonts.some((f) => f.id === id)) {
    doc.resources.fonts.push({
      id,
      family: familyName,
      weight,
      style,
      source: "substituted",
    });
  }
  return id;
}

interface FixedEditorCanvasProps {
  doc: Document;
  /** Push a new draft. Pass `coalesceKey` to collapse rapid same-key
   *  updates (typing in one run, dragging one layer) into a single
   *  undo entry. Omit for discrete actions (add, delete, recolor). */
  onChange: (next: Document, coalesceKey?: string) => void;
}

// Match FixedPageView's baseline → top-edge approximation so the canvas
// position matches the read-only viewer pixel-for-pixel.
const BASELINE_TO_TOP = 0.8;

// Clear space between the floating format bar and the line it belongs to.
// The bar is positioned off its own measured height plus this gap, so the
// two can't drift apart the way a single hardcoded offset did.
const TOOLBAR_GAP = 10;
// Height to assume for the first frame, before the bar has been measured:
// 24px controls (h-6) + 4px padding (py-0.5) + 2px border. Keeping this in
// step with the real bar only avoids a one-frame shift; the measurement is
// what actually places it.
const TOOLBAR_FALLBACK_H = 30;

// Z-order for paint: lower number = drawn first = at the back.
// Mirrors pdf-adapter/exporter.py _layer_order_key.
//
// Shapes split into two classes:
//   - "background" shapes (page-spanning header/footer bars, full-bleed
//     panels) paint behind images, since real PDFs often place images
//     *on top of* a colored background band.
//   - "decoration" shapes (table cell backgrounds, accent strips, dividers)
//     paint above images and below text.
const LAYER_PAINT_ORDER = {
  bgShape: 0,
  image: 1,
  shape: 2,
  annotation: 3,
  text: 4,
  form: 5,
} as const;

function shapeIsBackground(
  geom: { kind?: string; w?: { value: number }; h?: { value: number } } | undefined,
  pageWidthPt: number,
  pageHeightPt: number
): boolean {
  if (!geom || geom.kind !== "rect" || !geom.w || !geom.h) return false;
  const w = geom.w.value;
  const h = geom.h.value;
  if (pageWidthPt <= 0 || pageHeightPt <= 0) return false;
  const spansWidth = w / pageWidthPt >= 0.9;
  const spansHeight = h / pageHeightPt >= 0.9;
  const bigArea = (w * h) / (pageWidthPt * pageHeightPt) >= 0.2;
  return spansWidth || spansHeight || bigArea;
}

function layerPaintOrderKey(
  layer: Page["layers"][number],
  pageWidthPt: number,
  pageHeightPt: number
): number {
  if (layer.type === "shape") {
    const isBg = shapeIsBackground(
      layer.geometry as { kind?: string; w?: { value: number }; h?: { value: number } },
      pageWidthPt,
      pageHeightPt
    );
    return isBg ? LAYER_PAINT_ORDER.bgShape : LAYER_PAINT_ORDER.shape;
  }
  return LAYER_PAINT_ORDER[layer.type as keyof typeof LAYER_PAINT_ORDER] ?? 99;
}

/** Open a native colour picker, pre-filled with ``initial`` (#rrggbb). */
function pickColor(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "color";
    if (/^#[0-9a-fA-F]{6}$/.test(initial)) input.value = initial;
    input.onchange = () => resolve(input.value);
    input.click();
  });
}

/** Best-effort #rrggbb for a shape's current fill, for the picker default. */
function shapeFillHex(layer: UdmShapeLayer): string {
  const lit = (layer.fill as { color?: { literal?: Record<string, unknown> } } | undefined)?.color
    ?.literal;
  if (lit) {
    if (lit.kind === "hex" && typeof lit.hex === "string") return lit.hex;
    if (lit.kind === "rgb") {
      const h = (n: unknown) =>
        Math.max(0, Math.min(255, Number(n) || 0))
          .toString(16)
          .padStart(2, "0");
      return `#${h(lit.r)}${h(lit.g)}${h(lit.b)}`;
    }
  }
  return "#888888";
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** Composite ``overlayUrl`` into a sub-rectangle of ``baseUrl`` and return
 * the result as a PNG data URL. ``region`` is in the base image's own
 * intrinsic pixels. Used for region-scoped image replacement: the user
 * frames part of a (possibly page-sized) image and only that area is
 * swapped — the rest of the image is preserved.
 *
 * Crop strategy (lesson #6): face-aware. computeFaceAwareCrop lazy-
 * loads the face-api.js tiny detector model (~190KB, served from
 * /face-models) to find the largest face in the overlay and biases
 * the crop window to keep it in frame. Falls back to portrait-top-
 * bias when no face is detected or model load fails.
 */
async function compositeImageIntoRegion(
  baseUrl: string,
  baseW: number,
  baseH: number,
  overlayUrl: string,
  region: { x: number; y: number; w: number; h: number }
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = baseW;
  canvas.height = baseH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const base = await loadImageEl(baseUrl);
  ctx.drawImage(base, 0, 0, baseW, baseH);
  const overlay = await loadImageEl(overlayUrl);

  const { computeFaceAwareCrop } = await import("@/lib/face-crop");
  const { sx, sy, sw, sh } = await computeFaceAwareCrop(overlay, region.w / region.h);

  ctx.drawImage(overlay, sx, sy, sw, sh, region.x, region.y, region.w, region.h);
  return canvas.toDataURL("image/png");
}

function konvaFontStyle(font: FontResource | undefined): string {
  if (!font) return "normal";
  const weight = font.weight >= 600 ? "bold" : "normal";
  const italic = font.style === "italic" || font.style === "oblique" ? "italic" : "";
  return [weight, italic].filter(Boolean).join(" ") || "normal";
}

function konvaFontFamily(font: FontResource | undefined): string {
  if (!font) return "sans-serif";
  // Embedded subset → original family → metric-compatible clone →
  // class-correct generic. Canvas text honours the CSS fallback chain,
  // so missing glyphs (e.g. typed while editing) use the near-identical
  // clone rather than dropping to a generic. See lib/font-css.ts.
  return cssFontStack(font.family, font.id);
}

function runKey(pageIdx: number, layerIdx: number, runIdx: number): string {
  return `${pageIdx}:${layerIdx}:${runIdx}`;
}

interface PickedImage {
  dataUrl: string;
  width: number;
  height: number;
  format: string;
}

/** Open a native file picker and read the chosen image as a data URL. */
function pickImageFile(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const probe = new window.Image();
        probe.onload = () => {
          resolve({
            dataUrl,
            width: probe.naturalWidth,
            height: probe.naturalHeight,
            format: (file.type.split("/")[1] || "png").toLowerCase(),
          });
        };
        probe.onerror = () => resolve(null);
        probe.src = dataUrl;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

export default function FixedEditorCanvas({ doc, onChange }: FixedEditorCanvasProps) {
  const fixed = doc.content as FixedContent;
  const [scale, setScale] = useState(1);
  const isMobile = useIsMobile();
  // Fit the first page to the screen width (default on mobile, manual
  // "fit" button everywhere) so phone users don't get a page ~2x wider
  // than the viewport.
  const firstPageWidthPx = lengthToPx(fixed.pages[0]?.width ?? { value: 0, unit: "px" });
  // Two-finger pinch zooms the document; one finger still scrolls. The
  // same element is the scroll container, so it's also what "fit" has to
  // measure against — see fitScaleForWidth.
  const pinchRef = useRef<HTMLDivElement>(null);
  const fitToWidth = useCallback(() => {
    if (firstPageWidthPx > 0)
      setScale(fitScaleForWidth(firstPageWidthPx, pinchRef.current));
  }, [firstPageWidthPx]);
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current || !isMobile || firstPageWidthPx <= 0) return;
    setScale(fitScaleForWidth(firstPageWidthPx, pinchRef.current));
    didFit.current = true;
  }, [isMobile, firstPageWidthPx]);
  // Re-fit on rotate/resize while the page is still fitted, so turning a
  // phone sideways doesn't leave the document overflowing.
  useEffect(() => {
    if (!isMobile) return;
    const onResize = () => {
      if (firstPageWidthPx > 0)
        setScale(fitScaleForWidth(firstPageWidthPx, pinchRef.current));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [isMobile, firstPageWidthPx]);
  usePinchZoom(pinchRef, scale, setScale);
  // First-run coaching banner. Starts hidden to avoid an SSR/hydration
  // mismatch, then shows on mount unless the user dismissed it before
  // (persisted in localStorage so returning users aren't nagged).
  const [showCoach, setShowCoach] = useState(false);
  useEffect(() => {
    try {
      setShowCoach(localStorage.getItem("alldocs_editor_coach_dismissed") !== "1");
    } catch {
      setShowCoach(true);
    }
  }, []);
  const persistCoach = (dismissed: boolean) => {
    try {
      if (dismissed) localStorage.setItem("alldocs_editor_coach_dismissed", "1");
      else localStorage.removeItem("alldocs_editor_coach_dismissed");
    } catch {
      /* private mode / storage disabled — fine, just won't persist */
    }
  };
  const dismissCoach = useCallback(() => {
    setShowCoach(false);
    persistCoach(true);
  }, []);
  // Header "? tips" button — lets users bring the banner back after
  // they've dismissed it (the dismissal persists in localStorage, so
  // without this there'd be no way to see the tips again).
  const toggleCoach = useCallback(() => {
    setShowCoach((v) => {
      persistCoach(v); // hiding → persist dismissed; showing → clear it
      return !v;
    });
  }, []);
  const [editing, setEditing] = useState<EditingState | null>(null);
  // Runs whose text the user has changed this session. Used so OCR runs
  // (invisible by default — the scanned image shows the text) flip to
  // visible once edited, masking the stale pixels underneath.
  const [editedKeys, setEditedKeys] = useState<ReadonlySet<string>>(new Set());
  // Auto-detected form fields (Word-export style) are convenient on
  // real forms but noisy on prose docs that incidentally have rect
  // shapes — and the noisy case is the common one, because most
  // documents people open are prose, not forms. So this defaults to
  // OFF: the document opens looking like the document, and the header
  // toggle switches the detected fields on when they're actually
  // wanted. No re-import needed either way.
  const [showAutoDetected, setShowAutoDetected] = useState(false);
  const autoDetectedCount = useMemo(() => {
    let n = 0;
    for (const page of fixed.pages) {
      for (const layer of page.layers) {
        if (layer.type !== "form") continue;
        const fields = (layer as unknown as { fields?: Array<Record<string, unknown>> }).fields;
        if (!Array.isArray(fields)) continue;
        for (const f of fields) {
          if ((f._meta as { auto_detected?: boolean } | undefined)?.auto_detected) n++;
        }
      }
    }
    return n;
  }, [fixed]);

  // Set of `${pageIdx}:${layerIdx}` keys for the currently-selected
  // layers (added images only for now). Resize handles render only when
  // exactly one is selected; Delete + arrow nudge act on the whole set.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // In-session image library — extracted images the user wants to
  // reuse mid-edit. Cleared on save/discard with the rest of the
  // editor state. Each item carries its own data URL so it survives
  // any page-content edits / deletes.
  interface LibraryItem {
    id: string;
    dataUrl: string;
    width: number;
    height: number;
    format: string;
    label: string;
  }
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const selectionKey = (p: number, l: number) => `${p}:${l}`;
  const toggleSelected = useCallback((p: number, l: number, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = selectionKey(p, l);
      if (!additive) {
        return next.has(k) && next.size === 1 ? new Set() : new Set([k]);
      }
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  // ---- search across all pages -------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);

  const searchMatches = useMemo(
    () => findTextMatches(fixed, searchQuery, scale),
    [fixed, searchQuery, scale],
  );

  // Clamp the active index whenever the matches change.
  useEffect(() => {
    if (searchMatches.length === 0) {
      setSearchActiveIdx(0);
    } else if (searchActiveIdx >= searchMatches.length) {
      setSearchActiveIdx(0);
    }
  }, [searchMatches, searchActiveIdx]);

  // Refs to the per-page wrappers so the active match can scroll into view.
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const m = searchMatches[searchActiveIdx];
    if (!m) return;
    const el = pageRefs.current[m.pageIdx];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [searchActiveIdx, searchMatches, searchOpen]);

  // ---- delete + nudge for selected layers --------------------------
  // Pending "compact upward?" offer surfaced after a delete (lesson #5).
  // Holds the y-range of what was deleted, per page, so the follow-up
  // shift knows what to close.
  const [compactOffer, setCompactOffer] = useState<
    { pageIdx: number; yMinPt: number; yMaxPt: number } | null
  >(null);

  // Horizontal twin of the above. Every run is pinned to the x the PDF
  // recorded, so emptying one mid-line leaves a hole the rest of the
  // line can't close on its own — delete the "FE" that Word split out
  // of "FEMALE" and the remaining "MALE" stays exactly where it was.
  // Offer to pull the rest of the line left, the same way a delete
  // offers to pull the page up.
  // shiftPt is signed: positive closes a gap by pulling the rest of the
  // line left, negative makes room by pushing it right. Both arise the
  // same way — edited text needs a different amount of space than the
  // run it replaced — so they share one offer and one apply.
  const [gapOffer, setGapOffer] = useState<{
    pageIdx: number;
    layerIdx: number;
    baselineYPt: number;
    afterXPt: number;
    shiftPt: number;
  } | null>(null);
  // Runs on one visual line share a baseline to within rounding.
  const BASELINE_TOL_PT = 1.5;

  const applyCloseGap = useCallback(() => {
    if (!gapOffer) return;
    const { pageIdx, layerIdx, baselineYPt, afterXPt, shiftPt } = gapOffer;
    const next = structuredClone(doc) as Document;
    const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
    if (!layer || layer.type !== "text" || shiftPt === 0) {
      setGapOffer(null);
      return;
    }
    for (const run of layer.runs) {
      if (Math.abs(lengthToPt(run.y) - baselineYPt) > BASELINE_TOL_PT) continue;
      const x = lengthToPt(run.x);
      // Everything that starts after the edited run moves; the edited
      // run itself, and anything before it, stays put.
      if (x <= afterXPt + 0.5) continue;
      run.x = { value: x - shiftPt, unit: "pt" };
      // Moved runs no longer sit where their source span does, so the
      // patcher can't match them and falls back to a full re-render.
      // Mark them anyway so a move alone still counts as an edit.
      run._meta = { ...(run._meta ?? {}), edited: true };
    }
    setGapOffer(null);
    onChange(next, `close-gap-${pageIdx}-${layerIdx}`);
  }, [gapOffer, doc, onChange]);

  // Helper: rough y-extent of a layer in PDF points.
  const layerYExtent = (
    layer: { type: string } & Record<string, unknown>,
    resources: Document["resources"]
  ): { y0: number; y1: number } | null => {
    if (layer.type === "image") {
      const im = layer as unknown as { y: Length; height: Length };
      const y0 = lengthToPt(im.y);
      return { y0, y1: y0 + lengthToPt(im.height) };
    }
    if (layer.type === "text") {
      const t = layer as unknown as { runs: { y: Length; font_size: Length }[] };
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const r of t.runs) {
        const baselineY = lengthToPt(r.y);
        const size = lengthToPt(r.font_size);
        y0 = Math.min(y0, baselineY - size);
        y1 = Math.max(y1, baselineY);
      }
      if (y0 === Infinity) return null;
      return { y0, y1 };
    }
    if (layer.type === "shape") {
      const s = layer as unknown as { geometry: { kind?: string; y?: Length; h?: Length } };
      const g = s.geometry;
      if (g?.kind === "rect" && g.y && g.h) {
        const y0 = lengthToPt(g.y);
        return { y0, y1: y0 + lengthToPt(g.h) };
      }
    }
    void resources;
    return null;
  };

  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    const next = structuredClone(doc) as Document;
    const content = next.content as FixedContent;
    // Group by page, splice in reverse so indices stay valid.
    const byPage = new Map<number, number[]>();
    for (const key of selected) {
      const [p, l] = key.split(":").map(Number);
      if (p === undefined || l === undefined) continue;
      const arr = byPage.get(p) ?? [];
      arr.push(l);
      byPage.set(p, arr);
    }
    // Track the y-extents we actually deleted, per page, so a follow-up
    // compact pass knows what gap to close.
    const deletedExtents = new Map<number, { yMin: number; yMax: number }>();
    for (const [pageIdx, layerIdxs] of byPage) {
      const page = content.pages[pageIdx];
      if (!page) continue;
      layerIdxs.sort((a, b) => b - a);
      for (const l of layerIdxs) {
        // Only delete if it's an added/draggable layer — refuse to nuke
        // original-document content. Mirror the same gate as resize.
        const layer = page.layers[l];
        if (!layer) continue;
        if (layer.type === "image") {
          const ref = next.resources.images.find((i) => i.id === layer.image_id);
          const isAdded =
            ref?.data_ref?.startsWith("data:") &&
            !(ref._meta as { xref?: number } | undefined)?.xref;
          if (!isAdded) continue;
        } else if (layer.type === "text") {
          if (!layer.runs[0]?._meta?.added) continue;
        } else if (layer.type === "shape") {
          // Only added shapes are safe to delete; original-document
          // shapes are part of the rendered layout.
          if (!layer._meta?.added) continue;
        } else if (layer.type === "annotation") {
          // OK to delete
        } else {
          continue;
        }
        const ext = layerYExtent(layer as never, next.resources);
        if (ext) {
          const cur = deletedExtents.get(pageIdx);
          if (cur) {
            cur.yMin = Math.min(cur.yMin, ext.y0);
            cur.yMax = Math.max(cur.yMax, ext.y1);
          } else {
            deletedExtents.set(pageIdx, { yMin: ext.y0, yMax: ext.y1 });
          }
        }
        page.layers.splice(l, 1);
      }
    }
    setSelected(new Set());
    onChange(next);
    // Offer compact upward for the largest gap left by this deletion.
    // Lesson #5: per-edit decision, not a global setting. The banner
    // auto-clears on any subsequent edit.
    if (deletedExtents.size > 0) {
      let bestPage = -1;
      let bestGap = 0;
      let bestYMin = 0;
      let bestYMax = 0;
      for (const [p, ext] of deletedExtents) {
        const gap = ext.yMax - ext.yMin;
        if (gap > bestGap) {
          bestGap = gap;
          bestPage = p;
          bestYMin = ext.yMin;
          bestYMax = ext.yMax;
        }
      }
      // Only offer when the gap is visually meaningful (>= 12pt — one
      // line of body text). Smaller gaps aren't worth a UI prompt.
      if (bestGap >= 12 && bestPage >= 0) {
        setCompactOffer({ pageIdx: bestPage, yMinPt: bestYMin, yMaxPt: bestYMax });
      }
    }
  }, [doc, onChange, selected]);

  const applyCompactUpward = useCallback(() => {
    if (!compactOffer) return;
    const { pageIdx, yMinPt, yMaxPt } = compactOffer;
    const delta = yMaxPt - yMinPt;
    if (delta <= 0) {
      setCompactOffer(null);
      return;
    }
    const next = structuredClone(doc) as Document;
    const page = (next.content as FixedContent).pages[pageIdx];
    if (!page) {
      setCompactOffer(null);
      return;
    }
    // Shift every layer whose y-extent starts below the deleted region
    // upward by the gap height. Per-layer y mutation mirrors nudge.
    for (const layer of page.layers) {
      if (layer.type === "image") {
        const y = lengthToPt(layer.y);
        if (y >= yMaxPt) {
          layer.y = { value: y - delta, unit: "pt" };
        }
      } else if (layer.type === "text") {
        for (const run of layer.runs) {
          const y = lengthToPt(run.y);
          if (y >= yMaxPt) {
            run.y = { value: y - delta, unit: "pt" };
          }
        }
      } else if (layer.type === "shape") {
        const g = layer.geometry as { kind?: string; y?: Length };
        if (g?.kind === "rect" && g.y) {
          const y = lengthToPt(g.y);
          if (y >= yMaxPt) {
            g.y = { value: y - delta, unit: "pt" };
          }
        }
      }
    }
    setCompactOffer(null);
    onChange(next);
  }, [compactOffer, doc, onChange]);


  // --- Image opacity -----------------------------------------------------
  // UdmImageLayer already carries `opacity`, and both this canvas and the
  // exporter honour it — there was simply no way to set it. It matters most
  // for watermarks: the source watermark is faint because of a soft mask
  // baked into its pixels, so a replacement image arrives fully opaque and
  // buries the page until it can be dialled back.
  const selectedImageOpacityPct = useMemo(() => {
    if (selected.size !== 1) return null;
    const [p, l] = [...selected][0].split(":").map(Number);
    if (p === undefined || l === undefined) return null;
    const layer = fixed.pages[p]?.layers[l];
    if (layer?.type !== "image") return null;
    return Math.round(((layer as UdmImageLayer).opacity ?? 1) * 100);
  }, [selected, fixed]);

  const setSelectedImageOpacity = useCallback(
    (pct: number) => {
      if (selected.size !== 1) return;
      const [p, l] = [...selected][0].split(":").map(Number);
      if (p === undefined || l === undefined) return;
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      const layer = content.pages[p]?.layers[l];
      if (!layer || layer.type !== "image") return;
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      (layer as UdmImageLayer).opacity = clamped / 100;
      // Mark it edited so the patch exporter re-renders this image rather
      // than passing the untouched original through.
      ((layer as unknown as { _meta?: Record<string, unknown> })._meta ??= {}).edited = true;
      // One history entry per drag of the slider, not one per pixel.
      onChange(next, `img-opacity-${p}:${l}`);
    },
    [doc, onChange, selected]
  );

  const nudgeSelected = useCallback(
    (dxPt: number, dyPt: number) => {
      if (selected.size === 0) return;
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      for (const key of selected) {
        const [p, l] = key.split(":").map(Number);
        if (p === undefined || l === undefined) continue;
        const layer = content.pages[p]?.layers[l];
        if (!layer) continue;
        if (layer.type === "image") {
          layer.x = { value: lengthToPt(layer.x) + dxPt, unit: "pt" };
          layer.y = { value: lengthToPt(layer.y) + dyPt, unit: "pt" };
        } else if (layer.type === "text") {
          for (const run of layer.runs) {
            run.x = { value: lengthToPt(run.x) + dxPt, unit: "pt" };
            run.y = { value: lengthToPt(run.y) + dyPt, unit: "pt" };
          }
        } else if (layer.type === "shape") {
          const geom = layer.geometry as { kind?: string; x?: Length; y?: Length };
          if (geom?.kind === "rect" && geom.x && geom.y) {
            geom.x = { value: lengthToPt(geom.x) + dxPt, unit: "pt" };
            geom.y = { value: lengthToPt(geom.y) + dyPt, unit: "pt" };
          }
        }
      }
      // Coalesce all arrow-key nudges in this burst into one history entry.
      onChange(next, `nudge-${[...selected].sort().join(",")}`);
    },
    [doc, onChange, selected]
  );

  const updateRun = useCallback(
    (pageIdx: number, layerIdx: number, runIdx: number, commit: EditCommit) => {
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      const layer = content.pages[pageIdx]!.layers[layerIdx]!;
      if (layer.type !== "text") return;
      const run = layer.runs[runIdx]!;
      const wasText = run.text;
      run.text = commit.text;

      if (commit.text !== wasText) {
        // `width` records how wide the ORIGINAL text was, and the
        // renderers scale glyphs to fill it. Once the text changes that
        // figure describes something that no longer exists — keeping it
        // would stretch a shortened run across its old box. Drop it and
        // let the new text occupy its natural width.
        delete run.width;

        // Every run owns a fixed x, so changing a run's length doesn't
        // move its neighbours. Shorten it and a hole opens; lengthen it
        // and it runs into the next run — and typing spaces to separate
        // them only makes the overrun worse, because the space widens
        // the run that's already too wide. Measure what the new text
        // needs against the room available and offer to move the rest
        // of the line either way. Deleting a run outright is just the
        // case where the new text needs nothing.
        const y = lengthToPt(run.y);
        const x = lengthToPt(run.x);
        let nextX = Infinity;
        for (const other of layer.runs) {
          if (other === run) continue;
          if (Math.abs(lengthToPt(other.y) - y) > BASELINE_TOL_PT) continue;
          const ox = lengthToPt(other.x);
          if (ox > x && ox < nextX) nextX = ox;
        }
        if (Number.isFinite(nextX)) {
          const fontCss = `${commit.italic ? "italic" : "normal"} ${
            commit.bold ? 700 : 400
          } ${commit.sizePt * (96 / 72)}px ${FAMILY_CSS[commit.family]}`;
          const neededPt = measureTextPx(commit.text, fontCss) * (72 / 96);
          const slack = nextX - (x + neededPt);
          // Under a couple of points either way it's kerning, not a
          // hole, and not a collision worth reflowing a line over.
          if (Math.abs(slack) > 2) {
            setGapOffer({
              pageIdx,
              layerIdx,
              baselineYPt: y,
              afterXPt: x,
              shiftPt: slack,
            });
          }
        }
      }
      run.font_size = { value: commit.sizePt, unit: "pt" };
      // Bold + family are expressed by pointing the run at a substituted
      // FontResource of the right weight/family. The exporters resolve
      // font_id -> FontResource -> a bundled metric-compatible font.
      run.font_id = ensureFont(
        next,
        commit.family,
        commit.bold ? 700 : 400,
        commit.italic ? "italic" : "normal",
      );
      // Underline can't ride on font_id — there's no underlined weight to
      // point at — so it lives on the run and the exporters draw it.
      if (commit.underline) run.underline = true;
      else delete run.underline;
      // Colour + opacity (opacity rides in the colour's alpha channel).
      const { r, g, b } = hexToRgb(commit.colorHex);
      const a = Math.round((Math.max(0, Math.min(100, commit.opacityPct)) / 100) * 255);
      run.color = {
        literal: a < 255 ? { kind: "rgb", r, g, b, a } : { kind: "rgb", r, g, b },
      };
      // Stamp an explicit edit marker so the PDF exporter re-inserts this
      // run even when only its style changed (colour/size/opacity) and the
      // text is identical — the patcher's text-diff alone would miss those.
      run._meta = { ...(run._meta ?? {}), edited: true };
      setEditedKeys((prev) => new Set(prev).add(runKey(pageIdx, layerIdx, runIdx)));
      onChange(next, `edit-text-${pageIdx}-${layerIdx}-${runIdx}`);
    },
    [doc, onChange]
  );

  // Extract the currently single-selected image into the library so
  // the user can reuse it later in this editing session. Non-destructive:
  // the source layer stays on the page.
  const extractSelectedToLibrary = useCallback(async () => {
    if (selected.size !== 1) return;
    const onlyKey = [...selected][0];
    const [p, l] = onlyKey.split(":").map(Number);
    const content = doc.content as FixedContent;
    const layer = content.pages[p]?.layers[l];
    if (!layer || layer.type !== "image") return;
    const resource = doc.resources.images.find((i) => i.id === layer.image_id);
    if (!resource) return;
    let dataUrl = resource.data_ref ?? "";
    // For images that live on disk (uploaded PDFs), fetch their bytes
    // and convert to a data URL so the library item is self-contained.
    if (dataUrl && !dataUrl.startsWith("data:") && !dataUrl.startsWith("xref:")) {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch {
        return;
      }
    }
    if (!dataUrl.startsWith("data:")) return;
    setLibrary((prev) => [
      ...prev,
      {
        id: `lib_${Date.now()}_${prev.length}`,
        dataUrl,
        width: resource.width ?? 0,
        height: resource.height ?? 0,
        format: resource.format ?? "png",
        label: `image #${prev.length + 1}`,
      },
    ]);
    setLibraryOpen(true);
  }, [doc, selected]);

  // A lifted region (signature/stamp) arrives as a page-pixel capture;
  // knock its paper background out to alpha and shelve it in the library
  // ready to place anywhere — including after importing another document.
  const liftRegionToLibrary = useCallback(async (rawDataUrl: string) => {
    try {
      const lifted = await removeBackground(rawDataUrl);
      setLibrary((prev) => [
        ...prev,
        {
          id: `lib_${Date.now()}_${prev.length}`,
          dataUrl: lifted.dataUrl,
          width: lifted.width,
          height: lifted.height,
          format: "png",
          label: `lift #${prev.length + 1}`,
        },
      ]);
      setLibraryOpen(true);
    } catch {
      /* tiny/degenerate region — nothing to add */
    }
    // One-shot tool: a lift is a deliberate act, drop back to normal mode.
    setMode("none");
  }, []);

  // Bring an outside image into the library — the cross-document path
  // (e.g. a photo of a signature, or a stamp exported from another doc).
  // `clearBg` runs the same background knockout used for lifted regions.
  const addFileToLibrary = useCallback(async (clearBg: boolean) => {
    const picked = await pickImageFile();
    if (!picked) return;
    let { dataUrl, width, height, format } = picked;
    if (clearBg) {
      try {
        const lifted = await removeBackground(dataUrl);
        dataUrl = lifted.dataUrl;
        width = lifted.width;
        height = lifted.height;
        format = "png";
      } catch {
        /* keep the original if knockout fails */
      }
    }
    setLibrary((prev) => [
      ...prev,
      {
        id: `lib_${Date.now()}_${prev.length}`,
        dataUrl,
        width,
        height,
        format,
        label: clearBg ? `signature #${prev.length + 1}` : `image #${prev.length + 1}`,
      },
    ]);
    setLibraryOpen(true);
  }, []);

  // Place a library item onto the given page at a sensible position.
  const placeLibraryItem = useCallback(
    (item: LibraryItem, pageIdx: number) => {
      const next = structuredClone(doc) as Document;
      const page = (next.content as FixedContent).pages[pageIdx];
      if (!page) return;
      const dispW = 160;
      const dispH = item.width > 0 ? (dispW * item.height) / item.width : dispW;
      const imgId = `img_lib_${next.resources.images.length}_${Date.now()}`;
      next.resources.images.push({
        id: imgId,
        format: item.format as "png" | "jpeg" | "webp",
        width: item.width,
        height: item.height,
        data_ref: item.dataUrl,
      });
      page.layers.push({
        type: "image",
        image_id: imgId,
        x: { value: 72, unit: "pt" },
        y: { value: 72, unit: "pt" },
        width: { value: dispW, unit: "pt" },
        height: { value: dispH, unit: "pt" },
      });
      onChange(next);
    },
    [doc, onChange]
  );

  // The page currently most visible in the scroll viewport — where a
  // "place" from the library should land (signing page 6 shouldn't put
  // the signature on page 1).
  const mostVisiblePage = useCallback((): number => {
    const container = pinchRef.current;
    if (!container) return 0;
    const crect = container.getBoundingClientRect();
    let best = 0;
    let bestVisible = -1;
    pageRefs.current.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const visible = Math.min(r.bottom, crect.bottom) - Math.max(r.top, crect.top);
      if (visible > bestVisible) {
        bestVisible = visible;
        best = i;
      }
    });
    return best;
  }, []);

  const downloadLibraryItem = useCallback((item: LibraryItem) => {
    const a = document.createElement("a");
    a.href = item.dataUrl;
    a.download = `${item.label.replace(/\s+/g, "_")}.${item.format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const removeLibraryItem = useCallback((id: string) => {
    setLibrary((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const replaceImage = useCallback(
    async (imageId: string) => {
      const picked = await pickImageFile();
      if (!picked) return;
      const next = structuredClone(doc) as Document;
      const resource = next.resources.images.find((i) => i.id === imageId);
      if (!resource) return;
      // data: URL travels in the UDM; the exporter decodes it and calls
      // page.replace_image on the source xref recorded in _meta.xref.
      resource.data_ref = picked.dataUrl;
      resource.width = picked.width;
      resource.height = picked.height;
      resource.format = picked.format as typeof resource.format;
      onChange(next);
    },
    [doc, onChange]
  );

  // One exclusive editor tool at a time.
  const [mode, setMode] = useState<EditorMode>("none");
  const placeMode = mode === "region-image";
  const liftMode = mode === "lift-region";
  const recolorMode = mode === "recolor";
  const addTextMode = mode === "add-text";
  const addImageMode = mode === "add-image";
  const addRectMode = mode === "add-rect";
  const selectMode = mode === "select";
  const highlightMode = mode === "highlight";
  const commentMode = mode === "comment";
  const inkMode = mode === "ink";
  const addFieldTextMode = mode === "add-field-text";
  const addFieldCheckboxMode = mode === "add-field-checkbox";
  const addFieldRadioMode = mode === "add-field-radio";
  // Active radio group name — the next placed radio joins this group.
  // Lazily prompted the first time the user enters add-field-radio mode
  // without one set; "Esc out + retoggle" lets them switch groups.
  const [activeRadioGroup, setActiveRadioGroup] = useState<string | null>(null);
  const toggleMode = (m: EditorMode) => {
    setMode((cur) => (cur === m ? "none" : m));
    // Entering add-field-radio without an active group → prompt for one;
    // leaving radio mode resets so the next session starts a new group.
    if (m === "add-field-radio") {
      if (!activeRadioGroup && mode !== "add-field-radio") {
        const name =
          typeof window !== "undefined"
            ? window.prompt("Radio group name", "options")?.trim() || ""
            : "";
        setActiveRadioGroup(name || `radio_user_${Date.now()}`);
      }
    } else if (mode === "add-field-radio") {
      // Leaving radio mode — reset so re-entering prompts again.
      setActiveRadioGroup(null);
    }
  };
  const [layout, setLayout] = useState<"list" | "grid">("list");

  // Place a net-new text run where the user clicked and open the editor.
  const addTextRun = useCallback(
    (pageIdx: number, cx: number, cy: number) => {
      const next = structuredClone(doc) as Document;
      const fontId = ensureFont(next, "sans", 400);
      const content = next.content as FixedContent;
      const page = content.pages[pageIdx];
      if (!page) return;
      const xPt = (cx / scale) * (72 / 96);
      const yPt = (cy / scale) * (72 / 96);
      const layerIdx = page.layers.length;
      page.layers.push({
        type: "text",
        runs: [
          {
            text: "New text",
            font_id: fontId,
            font_size: { value: 14, unit: "pt" },
            color: { literal: { kind: "rgb", r: 0, g: 0, b: 0 } },
            x: { value: xPt, unit: "pt" },
            // run.y is the baseline-ish bottom; the click marks the top.
            y: { value: yPt + 14, unit: "pt" },
            _meta: { added: true },
          },
        ],
      });
      onChange(next);
      setMode("none");
      setEditing({ pageIdx, layerIdx, runIdx: 0, initialText: "New text" });
    },
    [doc, onChange, scale]
  );

  // Place a net-new image where the user clicked.
  const addImage = useCallback(
    async (pageIdx: number, cx: number, cy: number) => {
      const picked = await pickImageFile();
      setMode("none");
      if (!picked) return;
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      const page = content.pages[pageIdx];
      if (!page) return;
      const xPt = (cx / scale) * (72 / 96);
      const yPt = (cy / scale) * (72 / 96);
      const dispW = 160;
      const dispH = picked.width > 0 ? (dispW * picked.height) / picked.width : dispW;
      const imgId = `img_added_${next.resources.images.length}`;
      next.resources.images.push({
        id: imgId,
        format: picked.format as "png" | "jpeg" | "webp",
        width: picked.width,
        height: picked.height,
        data_ref: picked.dataUrl,
      });
      page.layers.push({
        type: "image",
        image_id: imgId,
        x: { value: xPt, unit: "pt" },
        y: { value: yPt, unit: "pt" },
        width: { value: dispW, unit: "pt" },
        height: { value: dispH, unit: "pt" },
      });
      onChange(next);
    },
    [doc, onChange, scale]
  );

  const recolorShape = useCallback(
    async (pageIdx: number, layerIdx: number) => {
      const fixedC = doc.content as FixedContent;
      const layer = fixedC.pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "shape") return;
      const picked = await pickColor(shapeFillHex(layer));
      if (!picked) return;
      const next = structuredClone(doc) as Document;
      const nextLayer = (next.content as FixedContent).pages[pageIdx]!.layers[layerIdx]!;
      if (nextLayer.type !== "shape") return;
      nextLayer.fill = { kind: "solid", color: { literal: { kind: "hex", hex: picked } } };
      onChange(next);
    },
    [doc, onChange]
  );

  // Region-scoped replacement: the user drags a box over part of an
  // image and only that area is swapped. Essential for flattened-image
  // PDFs (a whole scanned page is one image) — replacing the resource
  // outright would swap the entire page.
  const placeImageInRegion = useCallback(
    async (pageIdx: number, rect: { x: number; y: number; w: number; h: number }) => {
      const fixedContent = doc.content as FixedContent;
      const page = fixedContent.pages[pageIdx];
      if (!page) return;

      // Pick the image layer the region falls on — largest one whose
      // bounds contain the region's center.
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      let base: UdmImageLayer | null = null;
      let bestArea = -1;
      for (const layer of page.layers) {
        if (layer.type !== "image") continue;
        const ix = lengthToPx(layer.x) * scale;
        const iy = lengthToPx(layer.y) * scale;
        const iw = lengthToPx(layer.width) * scale;
        const ih = lengthToPx(layer.height) * scale;
        if (cx < ix || cx > ix + iw || cy < iy || cy > iy + ih) continue;
        const area = iw * ih;
        if (area > bestArea) {
          bestArea = area;
          base = layer;
        }
      }
      if (!base) {
        setMode("none");
        return;
      }

      const resource = doc.resources.images.find((i) => i.id === base!.image_id);
      if (!resource || !resource.data_ref || resource.data_ref.startsWith("xref:")) {
        setMode("none");
        return;
      }

      const picked = await pickImageFile();
      if (!picked) {
        setMode("none");
        return;
      }

      // Region (canvas px) -> the base image's intrinsic pixels.
      const ix = lengthToPx(base.x) * scale;
      const iy = lengthToPx(base.y) * scale;
      const iw = lengthToPx(base.width) * scale;
      const ih = lengthToPx(base.height) * scale;
      const region = {
        x: ((rect.x - ix) / iw) * resource.width,
        y: ((rect.y - iy) / ih) * resource.height,
        w: (rect.w / iw) * resource.width,
        h: (rect.h / ih) * resource.height,
      };

      try {
        const composited = await compositeImageIntoRegion(
          resource.data_ref,
          resource.width,
          resource.height,
          picked.dataUrl,
          region
        );
        const next = structuredClone(doc) as Document;
        const target = next.resources.images.find((i) => i.id === base!.image_id);
        if (target) {
          target.data_ref = composited;
          target.format = "png";
          onChange(next);
        }
      } catch {
        // Compositing failed (e.g. image load) — leave the doc untouched.
      } finally {
        setMode("none");
      }
    },
    [doc, onChange, scale]
  );

  // ---- annotation creation -----------------------------------------

  const addAnnotationLayer = useCallback(
    (pageIdx: number, kind: "highlight" | "comment" | "ink", data: Record<string, unknown>) => {
      const next = structuredClone(doc) as Document;
      const page = (next.content as FixedContent).pages[pageIdx];
      if (!page) return;
      page.layers.push({
        type: "annotation",
        kind,
        data: { ...data, _meta: { added: true } },
      } as never);
      onChange(next);
    },
    [doc, onChange]
  );

  const pxRectToPt = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      const k = (72 / 96) / scale;
      return { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k };
    },
    [scale]
  );

  const addHighlight = useCallback(
    (pageIdx: number, rect: { x: number; y: number; w: number; h: number }) => {
      const r = pxRectToPt(rect);
      addAnnotationLayer(pageIdx, "highlight", {
        rect: r,
        color: [255, 235, 59],
      });
      setMode("none");
    },
    [addAnnotationLayer, pxRectToPt]
  );

  const addComment = useCallback(
    (pageIdx: number, cx: number, cy: number) => {
      // Use the browser prompt for v1 — quick + functional. A nicer
      // inline popover can come later.
      const text = window.prompt("Comment:");
      setMode("none");
      if (!text) return;
      const k = (72 / 96) / scale;
      addAnnotationLayer(pageIdx, "comment", { x: cx * k, y: cy * k, text });
    },
    [addAnnotationLayer, scale]
  );

  const addInk = useCallback(
    (pageIdx: number, strokesPx: number[][][]) => {
      const k = (72 / 96) / scale;
      const strokes = strokesPx.map((s) => s.map(([x, y]) => [x * k, y * k]));
      addAnnotationLayer(pageIdx, "ink", {
        strokes,
        color: [200, 0, 0],
        width: 2.0,
      });
      setMode("none");
    },
    [addAnnotationLayer, scale]
  );

  // ---- form fields --------------------------------------------------

  const updateFormField = useCallback(
    (pageIdx: number, layerIdx: number, fieldIdx: number, value: unknown) => {
      const next = structuredClone(doc) as Document;
      const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "form") return;
      const fields = (layer as unknown as { fields: Array<Record<string, unknown>> }).fields;
      const field = fields?.[fieldIdx];
      if (!field) return;
      field.value = value;
      onChange(next, `field-${pageIdx}-${layerIdx}-${fieldIdx}`);
    },
    [doc, onChange]
  );

  // Radio click: set this field to "On" and clear every sibling that
  // shares the same group name (radios in the same group are mutually
  // exclusive). Searches doc-wide since radio groups can span pages.
  const selectRadioInGroup = useCallback(
    (pageIdx: number, layerIdx: number, fieldIdx: number) => {
      const next = structuredClone(doc) as Document;
      const allPages = (next.content as FixedContent).pages;
      const layer = allPages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "form") return;
      const fields = (layer as unknown as { fields: Array<Record<string, unknown>> }).fields;
      const target = fields?.[fieldIdx];
      if (!target) return;
      const groupName = String(target.name ?? "");
      const onValue =
        ((target._meta as { on_value?: string } | undefined)?.on_value) ?? "On";
      // Walk every form field across the doc; clear siblings, mark this one.
      for (const p of allPages) {
        for (const l of p.layers) {
          if (l.type !== "form") continue;
          const fs = (l as unknown as { fields?: Array<Record<string, unknown>> }).fields;
          if (!Array.isArray(fs)) continue;
          for (const f of fs) {
            if (f.kind !== "radio") continue;
            if (String(f.name ?? "") !== groupName) continue;
            f.value = f === target ? onValue : "Off";
          }
        }
      }
      onChange(next, `radio-${groupName}`);
    },
    [doc, onChange]
  );

  const addFormField = useCallback(
    (pageIdx: number, kind: "text" | "checkbox" | "radio", cx: number, cy: number) => {
      const next = structuredClone(doc) as Document;
      const page = (next.content as FixedContent).pages[pageIdx];
      if (!page) return;
      const k = (72 / 96) / scale;
      const xPt = cx * k;
      const yPt = cy * k;
      const sizePt =
        kind === "checkbox" || kind === "radio"
          ? { w: 14, h: 14 }
          : { w: 200, h: 22 };
      // For radios: every placement joins the active group; counter
      // suffix gives each button a distinct on-value within the group.
      let radioName = "";
      let radioOnValue = "";
      if (kind === "radio") {
        const groupName = activeRadioGroup || `radio_user_${Date.now()}`;
        if (!activeRadioGroup) setActiveRadioGroup(groupName);
        // Count siblings already in this group across the doc to mint
        // a stable on-value ("opt_1", "opt_2", …).
        let sib = 0;
        for (const p of (next.content as FixedContent).pages) {
          for (const l of p.layers) {
            if (l.type !== "form") continue;
            const fs = (l as unknown as { fields?: Array<Record<string, unknown>> }).fields;
            if (!Array.isArray(fs)) continue;
            for (const f of fs) {
              if (f.kind === "radio" && String(f.name ?? "") === groupName) sib++;
            }
          }
        }
        radioName = groupName;
        radioOnValue = `opt_${sib + 1}`;
      }
      // Find or create a form layer on this page.
      let formLayer = page.layers.find((l) => l.type === "form") as
        | { type: "form"; fields: Array<Record<string, unknown>> }
        | undefined;
      if (!formLayer) {
        formLayer = { type: "form", fields: [] };
        page.layers.push(formLayer as never);
      }
      const idx = formLayer.fields.length;
      formLayer.fields.push({
        kind,
        name: kind === "radio" ? radioName : `field_user_${Date.now()}_${idx}`,
        rect: { x: xPt, y: yPt, w: sizePt.w, h: sizePt.h },
        value: kind === "checkbox" ? false : kind === "radio" ? "Off" : "",
        _meta:
          kind === "radio"
            ? { added: true, on_value: radioOnValue }
            : { added: true },
      });
      onChange(next);
      setMode("none");
    },
    [doc, onChange, scale]
  );

  // Reposition a dragged text run / image layer (added content only).
  const moveRun = useCallback(
    (pageIdx: number, layerIdx: number, runIdx: number, xPt: number, yPt: number) => {
      const next = structuredClone(doc) as Document;
      const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "text") return;
      const run = layer.runs[runIdx];
      if (!run) return;
      run.x = { value: xPt, unit: "pt" };
      run.y = { value: yPt, unit: "pt" };
      onChange(next, `drag-run-${pageIdx}-${layerIdx}-${runIdx}`);
    },
    [doc, onChange]
  );

  const moveImageLayer = useCallback(
    (pageIdx: number, layerIdx: number, xPt: number, yPt: number) => {
      const next = structuredClone(doc) as Document;
      const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "image") return;
      layer.x = { value: xPt, unit: "pt" };
      layer.y = { value: yPt, unit: "pt" };
      onChange(next, `drag-image-${pageIdx}-${layerIdx}`);
    },
    [doc, onChange]
  );

  // Place a net-new rectangle shape from a drag-defined region.
  const addRect = useCallback(
    (pageIdx: number, rect: { x: number; y: number; w: number; h: number }) => {
      if (rect.w < 2 || rect.h < 2) {
        setMode("none");
        return;
      }
      const next = structuredClone(doc) as Document;
      const page = (next.content as FixedContent).pages[pageIdx];
      if (!page) return;
      const k = (72 / 96) / scale;
      page.layers.push({
        type: "shape",
        geometry: {
          kind: "rect",
          x: { value: rect.x * k, unit: "pt" },
          y: { value: rect.y * k, unit: "pt" },
          w: { value: rect.w * k, unit: "pt" },
          h: { value: rect.h * k, unit: "pt" },
        },
        // Default to a translucent gray so the rect is visible against
        // anything; user can immediately recolor.
        fill: { kind: "solid", color: { literal: { kind: "hex", hex: "#cbd5e1" } } },
        opacity: 0.6,
        _meta: { added: true },
      } as never);
      onChange(next);
      setMode("none");
    },
    [doc, onChange, scale]
  );

  // Resize a shape layer (rect geometry only for v1).
  const resizeShapeLayer = useCallback(
    (
      pageIdx: number,
      layerIdx: number,
      xPt: number,
      yPt: number,
      wPt: number,
      hPt: number
    ) => {
      const next = structuredClone(doc) as Document;
      const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "shape") return;
      const geom = layer.geometry as { kind?: string; x?: unknown; y?: unknown; w?: unknown; h?: unknown };
      if (geom?.kind !== "rect") return;
      geom.x = { value: xPt, unit: "pt" };
      geom.y = { value: yPt, unit: "pt" };
      geom.w = { value: wPt, unit: "pt" };
      geom.h = { value: hPt, unit: "pt" };
      onChange(next, `resize-shape-${pageIdx}-${layerIdx}`);
    },
    [doc, onChange]
  );

  // Resize an image layer by setting all four (x, y, width, height) at
  // once — corner handles change three or four values, edge handles two.
  // Coalesces under one key for the whole drag so undo collapses the
  // sequence into a single step.
  const resizeImageLayer = useCallback(
    (
      pageIdx: number,
      layerIdx: number,
      xPt: number,
      yPt: number,
      wPt: number,
      hPt: number
    ) => {
      const next = structuredClone(doc) as Document;
      const layer = (next.content as FixedContent).pages[pageIdx]?.layers[layerIdx];
      if (!layer || layer.type !== "image") return;
      layer.x = { value: xPt, unit: "pt" };
      layer.y = { value: yPt, unit: "pt" };
      layer.width = { value: wPt, unit: "pt" };
      layer.height = { value: hPt, unit: "pt" };
      onChange(next, `resize-image-${pageIdx}-${layerIdx}`);
    },
    [doc, onChange]
  );

  // Keyboard surface: Ctrl+F opens search; Esc closes search / clears
  // selection; Delete + arrows act on the selected layers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const target = e.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      // Ctrl+F always wins — we want our search, not the browser's.
      if (mod && key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (selected.size > 0) setSelected(new Set());
        return;
      }
      // Delete + arrow nudge only when nothing's being typed.
      if (inField) return;
      if (selected.size === 0) return;
      if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        nudgeSelected(dx, dy);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, selected, deleteSelected, nudgeSelected]);

  // Any mode other than "none" or "select" clears selection — recolor,
  // add-*, highlight, … shouldn't see leftover handles getting in the way.
  // "select" deliberately keeps selection (that's the whole point).
  useEffect(() => {
    if (mode !== "none" && mode !== "select") setSelected(new Set());
    // mode is the only thing we react to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div className="space-y-4">
      <EditorHeader
        scale={scale}
        onScaleChange={setScale}
        onFit={fitToWidth}
        mode={mode}
        onToggleMode={toggleMode}
        layout={layout}
        onLayoutChange={(l) => {
          setLayout(l);
          // Give each mode a sensible default zoom so the switch is
          // visible: grid drops to a thumbnail zoom, list returns to 100%.
          setScale((s) => (l === "grid" && s > 0.5 ? 0.4 : l === "list" && s < 0.5 ? 1 : s));
        }}
        autoDetectedCount={autoDetectedCount}
        showAutoDetected={showAutoDetected}
        onToggleAutoDetected={() => setShowAutoDetected((v) => !v)}
        canExtractToLibrary={(() => {
          if (selected.size !== 1) return false;
          const onlyKey = [...selected][0];
          const [p, l] = onlyKey.split(":").map(Number);
          const layer = fixed.pages[p]?.layers[l];
          return layer?.type === "image";
        })()}
        onExtractToLibrary={extractSelectedToLibrary}
        imageOpacityPct={selectedImageOpacityPct}
        onImageOpacityChange={setSelectedImageOpacity}
        libraryCount={library.length}
        libraryOpen={libraryOpen}
        onToggleLibrary={() => setLibraryOpen((v) => !v)}
        tipsOpen={showCoach}
        onToggleTips={toggleCoach}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((o) => !o)}
      />
      {showCoach && (
        <div className="flex items-start gap-3 border border-accent/40 bg-accent/5 px-4 py-3">
          <div>
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-accent mb-1">
              editing tips
            </div>
            <ul className="font-sans text-sm text-fg/85 space-y-0.5 leading-relaxed">
              <li>
                <span className="text-fg font-medium">Click any text</span> to edit it in
                place — Enter commits, Esc cancels.
              </li>
              <li>
                Pick a <span className="text-fg font-medium">tool</span> above to add text,
                images, shapes, highlights, or form fields.
              </li>
              <li>
                Use <span className="text-fg font-medium">select</span> to move and resize
                images and shapes. The hint at the top-right shows what the current tool does.
              </li>
            </ul>
          </div>
          <button
            onClick={dismissCoach}
            className="ml-auto shrink-0 font-mono text-[0.65rem] uppercase tracking-wider text-subtle hover:text-fg"
            title="Dismiss these tips"
          >
            ✕ dismiss
          </button>
        </div>
      )}
      {isMobile && (
        <div className="border border-border bg-elevated/40 px-3 py-2 font-sans text-xs text-muted leading-relaxed">
          <span className="text-fg">On a phone</span> you can view, zoom, fill
          fields, and edit text. For precise work — moving and resizing images,
          drawing — a larger screen works best.
        </div>
      )}
      <PageOpsPanel doc={doc} onChange={onChange} />
      {libraryOpen ? (
        <ImageLibraryPanel
          items={library}
          onPlace={(item) => {
            // Land on whichever page the user is actually looking at;
            // the placed image is draggable for fine positioning.
            placeLibraryItem(item, mostVisiblePage());
          }}
          onDownload={downloadLibraryItem}
          onRemove={removeLibraryItem}
          onAddFile={addFileToLibrary}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}
      {compactOffer ? (
        <div className="border border-accent/40 bg-accent/10 px-3 py-2 flex items-center gap-3 flex-wrap">
          <span className="label">
            page {compactOffer.pageIdx + 1} · {Math.round(compactOffer.yMaxPt - compactOffer.yMinPt)}pt gap
          </span>
          <span className="font-mono text-xs text-fg">
            close it by shifting content below up?
          </span>
          <button
            onClick={applyCompactUpward}
            className="font-mono text-xs px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-accent-fg"
          >
            ↑ compact upward
          </button>
          <button
            onClick={() => setCompactOffer(null)}
            className="font-mono text-xs px-2 py-1 border border-border text-muted hover:text-fg hover:border-fg"
          >
            leave gap
          </button>
        </div>
      ) : null}
      {gapOffer ? (
        <div className="border border-accent/40 bg-accent/10 px-3 py-2 flex items-center gap-3 flex-wrap">
          <span className="label">
            page {gapOffer.pageIdx + 1} · {Math.abs(Math.round(gapOffer.shiftPt))}pt{" "}
            {gapOffer.shiftPt > 0 ? "gap" : "overlap"}
          </span>
          <span className="font-mono text-xs text-fg">
            {gapOffer.shiftPt > 0
              ? "close it by pulling the rest of the line left?"
              : "this text now runs into the next — push the rest of the line right?"}
          </span>
          <button
            onClick={applyCloseGap}
            className="font-mono text-xs px-2 py-1 border border-accent text-accent hover:bg-accent hover:text-accent-fg"
          >
            {gapOffer.shiftPt > 0 ? "← close gap" : "→ make room"}
          </button>
          <button
            onClick={() => setGapOffer(null)}
            className="font-mono text-xs px-2 py-1 border border-border text-muted hover:text-fg hover:border-fg"
          >
            leave it
          </button>
        </div>
      ) : null}
      {searchOpen ? (
        <SearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          totalMatches={searchMatches.length}
          activeIdx={searchActiveIdx}
          onPrev={() =>
            setSearchActiveIdx((i) =>
              searchMatches.length === 0 ? 0 : (i - 1 + searchMatches.length) % searchMatches.length
            )
          }
          onNext={() =>
            setSearchActiveIdx((i) => (searchMatches.length === 0 ? 0 : (i + 1) % searchMatches.length))
          }
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      <div
        ref={pinchRef}
        className={
          (layout === "grid"
            ? "flex flex-wrap gap-6 [justify-content:safe_center]"
            : "space-y-6 flex flex-col [align-items:safe_center]") +
          " overflow-y-auto overflow-x-auto border border-border bg-bg/40 p-4"
        }
        // `safe center`: centre children when they fit, but fall back to
        // left/top when they don't. Without this, zooming a fixed-mode
        // page wider than the viewport pushes half the overflow off the
        // left edge where browser scrollbars can't reach.
        // touch-action pan-x/pan-y: one finger scrolls; two-finger pinch
        // is captured by usePinchZoom to zoom the document.
        style={{ maxHeight: "75vh", touchAction: "pan-x pan-y" }}
      >
        {fixed.pages.map((page, pageIdx) => (
          <div
            key={page.number}
            ref={(el) => { pageRefs.current[pageIdx] = el; }}
          >
            <div className="label mb-2">
              page {page.number} · {Math.round(lengthToPx(page.width))}×{Math.round(lengthToPx(page.height))}px
            </div>
            <FixedPageEditor
              page={page}
              pageIdx={pageIdx}
              doc={doc}
              scale={scale}
              editing={editing}
              editedKeys={editedKeys}
              placeMode={placeMode}
              liftMode={liftMode}
              onLiftRegion={liftRegionToLibrary}
              recolorMode={recolorMode}
              addTextMode={addTextMode}
              addImageMode={addImageMode}
              highlightMode={highlightMode}
              commentMode={commentMode}
              inkMode={inkMode}
              addFieldTextMode={addFieldTextMode}
              addFieldCheckboxMode={addFieldCheckboxMode}
              addFieldRadioMode={addFieldRadioMode}
              onStartEdit={setEditing}
              onCancelEdit={() => setEditing(null)}
              onCommitEdit={(state, commit) => {
                updateRun(state.pageIdx, state.layerIdx, state.runIdx, commit);
                setEditing(null);
              }}
              onReplaceImage={replaceImage}
              onPlaceRegion={(rect) => placeImageInRegion(pageIdx, rect)}
              onRecolorShape={(layerIdx) => recolorShape(pageIdx, layerIdx)}
              onAddText={(cx, cy) => addTextRun(pageIdx, cx, cy)}
              onAddImage={(cx, cy) => addImage(pageIdx, cx, cy)}
              onAddHighlight={(rect) => addHighlight(pageIdx, rect)}
              onAddComment={(cx, cy) => addComment(pageIdx, cx, cy)}
              onAddInk={(strokes) => addInk(pageIdx, strokes)}
              onAddField={(kind, cx, cy) => addFormField(pageIdx, kind, cx, cy)}
              onUpdateField={(layerIdx, fieldIdx, value) =>
                updateFormField(pageIdx, layerIdx, fieldIdx, value)
              }
              onSelectRadio={(layerIdx, fieldIdx) =>
                selectRadioInGroup(pageIdx, layerIdx, fieldIdx)
              }
              onMoveRun={(layerIdx, runIdx, xPt, yPt) =>
                moveRun(pageIdx, layerIdx, runIdx, xPt, yPt)
              }
              onMoveImage={(layerIdx, xPt, yPt) => moveImageLayer(pageIdx, layerIdx, xPt, yPt)}
              selectedKeys={selected}
              pageSelectionKeyOf={(layerIdx) => selectionKey(pageIdx, layerIdx)}
              onSelect={(layerIdx, additive) => {
                if (layerIdx === null) setSelected(new Set());
                else toggleSelected(pageIdx, layerIdx, additive);
              }}
              onResizeImage={(layerIdx, xPt, yPt, wPt, hPt) =>
                resizeImageLayer(pageIdx, layerIdx, xPt, yPt, wPt, hPt)
              }
              onResizeShape={(layerIdx, xPt, yPt, wPt, hPt) =>
                resizeShapeLayer(pageIdx, layerIdx, xPt, yPt, wPt, hPt)
              }
              selectMode={selectMode}
              addRectMode={addRectMode}
              onAddRect={(rect) => addRect(pageIdx, rect)}
              searchMatches={searchMatches.filter((m) => m.pageIdx === pageIdx)}
              activeMatchKey={
                searchMatches[searchActiveIdx]
                  ? `${searchMatches[searchActiveIdx].pageIdx}:${searchMatches[searchActiveIdx].layerIdx}:${searchMatches[searchActiveIdx].runIdx}`
                  : null
              }
              showAutoDetected={showAutoDetected}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

interface EditingState {
  pageIdx: number;
  layerIdx: number;
  runIdx: number;
  initialText: string;
}

/** In-session extracted-images workspace.
 *
 * Users right-click / button-extract any image into here for later
 * reuse. Each entry can be placed back onto the document or
 * downloaded as a file. Cleared on save / discard with the rest of
 * the editor state. */
function ImageLibraryPanel({
  items,
  onPlace,
  onDownload,
  onRemove,
  onAddFile,
  onClose,
}: {
  items: Array<{
    id: string;
    dataUrl: string;
    width: number;
    height: number;
    format: string;
    label: string;
  }>;
  onPlace: (item: { id: string; dataUrl: string; width: number; height: number; format: string; label: string }) => void;
  onDownload: (item: { id: string; dataUrl: string; width: number; height: number; format: string; label: string }) => void;
  onRemove: (id: string) => void;
  /** Import an outside image; `clearBg=true` knocks its background out
   * (the cross-document signature path). */
  onAddFile: (clearBg: boolean) => void;
  onClose: () => void;
}) {
  const btn =
    "font-mono text-[0.65rem] uppercase tracking-wider px-1.5 py-0.5 border border-border text-muted hover:text-fg hover:border-fg";
  return (
    <div className="border border-border bg-surface px-3 py-2">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <span className="label">library · {items.length}</span>
        <div className="flex items-center gap-1">
          <button
            className={btn}
            onClick={() => onAddFile(true)}
            title="Import a photo/scan of a signature or stamp — its background is made transparent"
          >
            ＋ signature
          </button>
          <button
            className={btn}
            onClick={() => onAddFile(false)}
            title="Import an image as-is (background kept)"
          >
            ＋ image
          </button>
          <button
            className={btn}
            onClick={onClose}
            aria-label="Close library panel"
          >
            ✕
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="font-sans text-xs text-muted leading-relaxed py-1">
          Lift a signature or stamp off the page with the ✂ lift tool, or
          import one from a file — then place it on any page.
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="border border-border bg-bg p-2 flex flex-col gap-1.5"
            style={{ width: 140 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.dataUrl}
              alt={item.label}
              className="w-full border border-border"
              // Checkerboard behind the thumb so a knocked-out background
              // is visibly transparent rather than looking plain white.
              style={{
                height: 90,
                objectFit: "contain",
                background:
                  "repeating-conic-gradient(#e2e2e2 0% 25%, #ffffff 0% 50%) 0 0 / 12px 12px",
              }}
            />
            <div
              className="font-mono text-[0.6rem] text-subtle truncate"
              title={`${item.width}×${item.height} ${item.format}`}
            >
              {item.width}×{item.height}
            </div>
            <div className="flex gap-1">
              <button
                className={btn + " flex-1"}
                onClick={() => onPlace(item)}
                title="Place on the page you're viewing (drag to fine-position)"
              >
                ↘ place
              </button>
              <button
                className={btn}
                onClick={() => onDownload(item)}
                aria-label="Download image"
                title="Download"
              >
                ↓
              </button>
              <button
                className={btn}
                onClick={() => onRemove(item.id)}
                aria-label="Remove from library"
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Page operations strip — reorder / rotate / delete / insert blank.
 * Mutates doc.content.pages; the exporter's page-ops path rebuilds the
 * PDF from the source pages in this order. */
function PageOpsPanel({ doc, onChange }: { doc: Document; onChange: (d: Document) => void }) {
  const pages = (doc.content as FixedContent).pages;

  const apply = (mutate: (pages: Page[]) => Page[]) => {
    const next = structuredClone(doc) as Document;
    const content = next.content as FixedContent;
    content.pages = mutate(content.pages);
    content.pages.forEach((p, i) => {
      p.number = i + 1;
    });
    onChange(next);
  };

  const move = (i: number, dir: -1 | 1) =>
    apply((ps) => {
      const j = i + dir;
      if (j < 0 || j >= ps.length) return ps;
      const copy = [...ps];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });

  const rotate = (i: number) =>
    apply((ps) => {
      const copy = [...ps];
      copy[i] = { ...copy[i]!, rotation: (((copy[i]!.rotation ?? 0) + 90) % 360) };
      return copy;
    });

  const remove = (i: number) => apply((ps) => ps.filter((_, idx) => idx !== i));

  const insertBlank = (afterIdx: number) =>
    apply((ps) => {
      const ref = ps[0]!;
      const blank: Page = {
        number: 0,
        width: structuredClone(ref.width),
        height: structuredClone(ref.height),
        layers: [],
        rotation: 0,
        _meta: {},
      };
      const copy = [...ps];
      copy.splice(afterIdx + 1, 0, blank);
      return copy;
    });

  // Selected page index, clamped if pages were removed.
  const [selRaw, setSel] = useState(0);
  const sel = Math.min(selRaw, pages.length - 1);
  const selPage = pages[sel]!;
  const inserted = (selPage._meta?.source_page ?? null) === null;

  // Reordering pages is a deliberate, occasional job — not something a
  // phone user wants six small buttons of in their way on every visit.
  // Collapse it behind its own control and give the targets real size
  // once it's open.
  const isMobile = useIsMobile();
  const [opsOpen, setOpsOpen] = useState(false);

  const act = `font-mono text-xs border border-border text-muted hover:text-fg hover:border-fg disabled:opacity-25 disabled:hover:text-muted disabled:hover:border-border ${
    isMobile ? "px-3 h-11 inline-flex items-center" : "px-2 py-1"
  }`;

  if (isMobile && !opsOpen) {
    return (
      <div className="border border-border bg-surface px-3 py-2">
        <button
          onClick={() => setOpsOpen(true)}
          className="font-mono text-xs h-11 inline-flex items-center text-muted"
        >
          ▶ pages ({pages.length})
        </button>
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface px-3 py-2 flex items-center gap-2 flex-wrap">
      {isMobile && (
        <button
          onClick={() => setOpsOpen(false)}
          className="font-mono text-xs h-11 inline-flex items-center text-muted mr-1"
        >
          ▼ pages
        </button>
      )}
      <span className="label">page</span>
      <select
        value={sel}
        onChange={(e) => setSel(Number(e.target.value))}
        className="font-mono text-xs px-1.5 py-1 bg-bg border border-border text-fg"
      >
        {pages.map((p, i) => (
          <option key={i} value={i}>
            {i + 1}
            {(p._meta?.source_page ?? null) === null ? " (blank)" : ""}
            {p.rotation ? ` · ${p.rotation}°` : ""}
          </option>
        ))}
      </select>
      <span className="label text-subtle">of {pages.length}</span>

      <span className="w-px h-5 bg-border mx-1" />
      <button className={act} disabled={sel === 0} onClick={() => { move(sel, -1); setSel(sel - 1); }}>
        ◀ move left
      </button>
      <button
        className={act}
        disabled={sel === pages.length - 1}
        onClick={() => { move(sel, 1); setSel(sel + 1); }}
      >
        move right ▶
      </button>
      <button className={act} onClick={() => rotate(sel)}>
        ⟳ rotate{selPage.rotation ? ` (${selPage.rotation}°)` : ""}
      </button>
      <button className={act} disabled={pages.length <= 1} onClick={() => remove(sel)}>
        ✕ delete
      </button>
      <button className={act} onClick={() => { insertBlank(sel); setSel(sel + 1); }}>
        ＋ insert blank after
      </button>
      {inserted ? <span className="label text-subtle">inserted blank page</span> : null}
    </div>
  );
}

// Image layers smaller than this (PDF points, either dimension) don't get a
// replace button — bullet glyphs and icon-sized images would just be noise.
const MIN_REPLACEABLE_PT = 48;

function FixedPageEditor({
  page,
  pageIdx,
  doc,
  scale,
  editing,
  editedKeys,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onReplaceImage,
  placeMode,
  liftMode,
  onLiftRegion,
  onPlaceRegion,
  recolorMode,
  onRecolorShape,
  addTextMode,
  addImageMode,
  onAddText,
  onAddImage,
  highlightMode,
  commentMode,
  inkMode,
  onAddHighlight,
  onAddComment,
  onAddInk,
  addFieldTextMode,
  addFieldCheckboxMode,
  addFieldRadioMode,
  onAddField,
  onUpdateField,
  onMoveRun,
  onMoveImage,
  onSelectRadio,
  selectedKeys,
  pageSelectionKeyOf,
  onSelect,
  onResizeImage,
  onResizeShape,
  selectMode,
  addRectMode,
  onAddRect,
  searchMatches,
  activeMatchKey,
  showAutoDetected,
}: {
  page: Page;
  pageIdx: number;
  doc: Document;
  scale: number;
  editing: EditingState | null;
  editedKeys: ReadonlySet<string>;
  onStartEdit: (s: EditingState) => void;
  onCancelEdit: () => void;
  onCommitEdit: (s: EditingState, commit: EditCommit) => void;
  onReplaceImage: (imageId: string) => void;
  placeMode: boolean;
  liftMode: boolean;
  onLiftRegion: (dataUrl: string) => void;
  onPlaceRegion: (rect: { x: number; y: number; w: number; h: number }) => void;
  recolorMode: boolean;
  onRecolorShape: (layerIdx: number) => void;
  addTextMode: boolean;
  addImageMode: boolean;
  onAddText: (cx: number, cy: number) => void;
  onAddImage: (cx: number, cy: number) => void;
  highlightMode: boolean;
  commentMode: boolean;
  inkMode: boolean;
  onAddHighlight: (rect: { x: number; y: number; w: number; h: number }) => void;
  onAddComment: (cx: number, cy: number) => void;
  onAddInk: (strokesPx: number[][][]) => void;
  addFieldTextMode: boolean;
  addFieldCheckboxMode: boolean;
  addFieldRadioMode: boolean;
  onAddField: (kind: "text" | "checkbox" | "radio", cx: number, cy: number) => void;
  onUpdateField: (layerIdx: number, fieldIdx: number, value: unknown) => void;
  onSelectRadio: (layerIdx: number, fieldIdx: number) => void;
  onMoveRun: (layerIdx: number, runIdx: number, xPt: number, yPt: number) => void;
  onMoveImage: (layerIdx: number, xPt: number, yPt: number) => void;
  selectedKeys: ReadonlySet<string>;
  pageSelectionKeyOf: (layerIdx: number) => string;
  onSelect: (layerIdx: number | null, additive: boolean) => void;
  onResizeImage: (
    layerIdx: number,
    xPt: number,
    yPt: number,
    wPt: number,
    hPt: number
  ) => void;
  onResizeShape: (
    layerIdx: number,
    xPt: number,
    yPt: number,
    wPt: number,
    hPt: number
  ) => void;
  selectMode: boolean;
  addRectMode: boolean;
  onAddRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  searchMatches: ReadonlyArray<{
    layerIdx: number;
    runIdx: number;
    xPx: number;
    yPx: number;
    wPx: number;
    hPx: number;
  }>;
  activeMatchKey: string | null;
  showAutoDetected: boolean;
}) {
  const w = lengthToPx(page.width) * scale;
  const h = lengthToPx(page.height) * scale;
  // Layer paint-order classification operates in PDF points (UDM source units).
  const pageWPt = page.width.unit === "pt" ? page.width.value : lengthToPx(page.width) / (96 / 72);
  const pageHPt = page.height.unit === "pt" ? page.height.value : lengthToPx(page.height) / (96 / 72);

  // Stage handle for pixel capture (the ✂ lift tool rasterizes the
  // selected region straight off the rendered canvas).
  const stageRef = useRef<KonvaStageType | null>(null);

  // Page rotation: the inner W×H surface is rotated about its centre and
  // re-centred inside an outer box whose dimensions account for the
  // rotated footprint (swapped for 90° / 270°).
  const rot = (((page.rotation ?? 0) % 360) + 360) % 360;
  const rotated = rot === 90 || rot === 270;
  const outerW = rotated ? h : w;
  const outerH = rotated ? w : h;

  return (
    <div style={{ width: outerW, height: outerH, position: "relative" }}>
      <div
        className="relative bg-white border border-border"
        style={{
          width: w,
          height: h,
          position: "absolute",
          left: (outerW - w) / 2,
          top: (outerH - h) / 2,
          transform: rot ? `rotate(${rot}deg)` : undefined,
          transformOrigin: "center center",
        }}
      >
      <Stage
        ref={stageRef}
        width={w}
        height={h}
        onMouseDown={(e: KonvaEventObject<MouseEvent>) => {
          // Click on the empty stage background → deselect. Clicks on a
          // shape/image/handle stop propagation upstream, so this only
          // fires when no node was hit.
          if (e.target === e.target.getStage()) onSelect(null, false);
        }}
      >
        <Layer listening>
          {page.layers
            .map((layer, layerIdx) => ({ layer, layerIdx }))
            .sort(
              (a, b) =>
                layerPaintOrderKey(a.layer, pageWPt, pageHPt) -
                layerPaintOrderKey(b.layer, pageWPt, pageHPt)
            )
            .map(({ layer, layerIdx }) => {
              if (layer.type === "shape") {
                const selKey = pageSelectionKeyOf(layerIdx);
                const isShapeSelected = selectedKeys.has(selKey);
                return (
                  <ShapeNode
                    key={layerIdx}
                    layer={layer}
                    scale={scale}
                    interactive={recolorMode || selectMode}
                    isSelected={isShapeSelected}
                    onClick={(additive) => {
                      if (recolorMode) onRecolorShape(layerIdx);
                      else if (selectMode) onSelect(layerIdx, additive);
                    }}
                  />
                );
              }
              if (layer.type === "image") {
                return (
                  <ImageNode
                    key={layerIdx}
                    layer={layer}
                    resources={doc.resources}
                    scale={scale}
                    onMove={(xPt, yPt) => onMoveImage(layerIdx, xPt, yPt)}
                    onSelect={(additive) => onSelect(layerIdx, additive)}
                    isSelected={selectedKeys.has(pageSelectionKeyOf(layerIdx))}
                    forceInteractive={selectMode}
                  />
                );
              }
              if (layer.type === "text") {
                return (
                  <TextNodes
                    key={layerIdx}
                    layer={layer}
                    layerIdx={layerIdx}
                    pageIdx={pageIdx}
                    resources={doc.resources}
                    scale={scale}
                    editing={editing}
                    editedKeys={editedKeys}
                    onStartEdit={onStartEdit}
                    onMoveRun={onMoveRun}
                  />
                );
              }
              if (layer.type === "annotation") {
                return <AnnotationNode key={layerIdx} layer={layer} scale={scale} />;
              }
              return null;
            })}
          {/* Resize handles only show for a single selection on this page. */}
          {(() => {
            if (selectedKeys.size !== 1) return null;
            const onlyKey = [...selectedKeys][0];
            const [p, l] = onlyKey.split(":").map(Number);
            if (p !== pageIdx) return null;
            const layer = page.layers[l];
            if (!layer) return null;
            if (layer.type === "image") {
              return (
                <ResizeHandles
                  xPx={lengthToPx(layer.x) * scale}
                  yPx={lengthToPx(layer.y) * scale}
                  wPx={lengthToPx(layer.width) * scale}
                  hPx={lengthToPx(layer.height) * scale}
                  scale={scale}
                  onResize={(xPt, yPt, wPt, hPt) =>
                    onResizeImage(l, xPt, yPt, wPt, hPt)
                  }
                />
              );
            }
            if (layer.type === "shape") {
              const geom = layer.geometry as
                | { kind?: string; x?: Length; y?: Length; w?: Length; h?: Length }
                | undefined;
              if (geom?.kind !== "rect" || !geom.x || !geom.y || !geom.w || !geom.h) return null;
              return (
                <ResizeHandles
                  xPx={lengthToPx(geom.x) * scale}
                  yPx={lengthToPx(geom.y) * scale}
                  wPx={lengthToPx(geom.w) * scale}
                  hPx={lengthToPx(geom.h) * scale}
                  scale={scale}
                  onResize={(xPt, yPt, wPt, hPt) =>
                    onResizeShape(l, xPt, yPt, wPt, hPt)
                  }
                />
              );
            }
            return null;
          })()}
          {searchMatches.map((m) => {
            const key = `${pageIdx}:${m.layerIdx}:${m.runIdx}`;
            const active = key === activeMatchKey;
            return (
              <KonvaRect
                key={key}
                x={m.xPx}
                y={m.yPx}
                width={m.wPx}
                height={m.hPx}
                fill={active ? "#fb923c" : "#fde047"}
                opacity={active ? 0.55 : 0.4}
                listening={false}
              />
            );
          })}
        </Layer>
      </Stage>
      {editing && editing.pageIdx === pageIdx ? (
        <TextEditOverlay
          state={editing}
          page={page}
          doc={doc}
          scale={scale}
          onCommit={onCommitEdit}
          onCancel={onCancelEdit}
        />
      ) : null}
      {placeMode ? <RegionSelectOverlay onComplete={onPlaceRegion} /> : null}
      {liftMode ? (
        <RegionSelectOverlay
          accentColor="#00d9a5"
          onComplete={(rect) => {
            const stage = stageRef.current;
            if (!stage) return;
            // Capture at ~300 DPI equivalent regardless of the current
            // zoom, so a lifted stamp keeps its quality when re-placed
            // larger. Stage px per pt = (96/72)·scale → ratio 3.125/scale.
            const pixelRatio = Math.min(8, Math.max(1.5, 3.125 / scale));
            try {
              const dataUrl = stage.toDataURL({
                x: rect.x,
                y: rect.y,
                width: rect.w,
                height: rect.h,
                pixelRatio,
                mimeType: "image/png",
              });
              onLiftRegion(dataUrl);
            } catch {
              /* tainted canvas or degenerate rect — nothing to lift */
            }
          }}
        />
      ) : null}
      {addRectMode ? (
        <RegionSelectOverlay onComplete={onAddRect} accentColor="#cbd5e1" />
      ) : null}
      {highlightMode ? (
        <RegionSelectOverlay onComplete={onAddHighlight} accentColor="#ffeb3b" />
      ) : null}
      {addTextMode ? <ClickPlaceOverlay onPlace={onAddText} /> : null}
      {addImageMode ? <ClickPlaceOverlay onPlace={onAddImage} /> : null}
      {commentMode ? <ClickPlaceOverlay onPlace={onAddComment} /> : null}
      {inkMode ? <InkOverlay onComplete={onAddInk} /> : null}
      {addFieldTextMode ? (
        <ClickPlaceOverlay onPlace={(cx, cy) => onAddField("text", cx, cy)} />
      ) : null}
      {addFieldCheckboxMode ? (
        <ClickPlaceOverlay onPlace={(cx, cy) => onAddField("checkbox", cx, cy)} />
      ) : null}
      {addFieldRadioMode ? (
        <ClickPlaceOverlay onPlace={(cx, cy) => onAddField("radio", cx, cy)} />
      ) : null}
      <FormFieldsOverlay
        page={page}
        scale={scale}
        onUpdateField={onUpdateField}
        onSelectRadio={onSelectRadio}
        showAutoDetected={showAutoDetected}
      />
      {!placeMode &&
      !liftMode &&
      !addTextMode &&
      !addImageMode &&
      !addRectMode &&
      !selectMode &&
      !highlightMode &&
      !commentMode &&
      !inkMode &&
      !addFieldTextMode &&
      !addFieldCheckboxMode &&
      !addFieldRadioMode ? (
        <ImageReplaceButtons
          page={page}
          scale={scale}
          onReplaceImage={onReplaceImage}
          isLayerSelected={(i) => selectedKeys.has(pageSelectionKeyOf(i))}
        />
      ) : null}
      </div>
    </div>
  );
}

/** Transparent overlay that reports a single click position (canvas px).
 * Used by add-text and add-image modes to place new content. */
function ClickPlaceOverlay({ onPlace }: { onPlace: (cx: number, cy: number) => void }) {
  return (
    <div
      className="absolute inset-0 z-30"
      style={{ cursor: "crosshair" }}
      onMouseDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onPlace(e.clientX - r.left, e.clientY - r.top);
      }}
    />
  );
}

/** Full-page transparent overlay active in "place image" mode. The user
 * drags a rectangle; on release it's reported (canvas px) so the caller
 * can composite a picked image into that region. */
function RegionSelectOverlay({
  onComplete,
  accentColor,
}: {
  onComplete: (rect: { x: number; y: number; w: number; h: number }) => void;
  accentColor?: string;
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);

  const rect =
    start && cur
      ? {
          x: Math.min(start.x, cur.x),
          y: Math.min(start.y, cur.y),
          w: Math.abs(cur.x - start.x),
          h: Math.abs(cur.y - start.y),
        }
      : null;

  const localPoint = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div
      className="absolute inset-0 z-30"
      style={{ cursor: "crosshair" }}
      onMouseDown={(e) => {
        const p = localPoint(e);
        setStart(p);
        setCur(p);
      }}
      onMouseMove={(e) => {
        if (start) setCur(localPoint(e));
      }}
      onMouseUp={() => {
        if (rect && rect.w >= 8 && rect.h >= 8) onComplete(rect);
        setStart(null);
        setCur(null);
      }}
    >
      {rect ? (
        <div
          className={
            accentColor
              ? "absolute border-2 pointer-events-none"
              : "absolute border-2 border-accent bg-accent/15 pointer-events-none"
          }
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            ...(accentColor
              ? { borderColor: accentColor, background: `${accentColor}40` }
              : {}),
          }}
        />
      ) : null}
    </div>
  );
}

/** Freehand drawing overlay — one stroke per use. mousedown starts
 * recording, mousemove appends points, mouseup commits the stroke. */
function InkOverlay({ onComplete }: { onComplete: (strokes: number[][][]) => void }) {
  const [points, setPoints] = useState<number[][]>([]);
  const drawingRef = useRef(false);

  const localPoint = (e: React.MouseEvent<HTMLDivElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const polyline = points.length >= 2 ? points.map((p) => `${p[0]},${p[1]}`).join(" ") : "";

  return (
    <div
      className="absolute inset-0 z-30"
      style={{ cursor: "crosshair" }}
      onMouseDown={(e) => {
        drawingRef.current = true;
        setPoints([localPoint(e)]);
      }}
      onMouseMove={(e) => {
        if (!drawingRef.current) return;
        setPoints((cur) => [...cur, localPoint(e)]);
      }}
      onMouseUp={() => {
        drawingRef.current = false;
        if (points.length >= 2) onComplete([points]);
        setPoints([]);
      }}
      onMouseLeave={() => {
        if (drawingRef.current && points.length >= 2) onComplete([points]);
        drawingRef.current = false;
        setPoints([]);
      }}
    >
      {polyline ? (
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: "100%", height: "100%" }}
        >
          <polyline
            points={polyline}
            fill="none"
            stroke="#c00000"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </div>
  );
}

/** DOM overlay of fillable form fields for a page. Each field is a
 * native text input or checkbox positioned at its rect — typing /
 * toggling updates the UDM. Added fields get a faint amber border so
 * users can tell what they placed. */
function FormFieldsOverlay({
  page,
  scale,
  onUpdateField,
  onSelectRadio,
  showAutoDetected,
}: {
  page: Page;
  scale: number;
  onUpdateField: (layerIdx: number, fieldIdx: number, value: unknown) => void;
  onSelectRadio: (layerIdx: number, fieldIdx: number) => void;
  showAutoDetected: boolean;
}) {
  const ptToPx = (pt: number) => pt * (96 / 72) * scale;
  const elements: React.ReactElement[] = [];
  page.layers.forEach((layer, layerIdx) => {
    if (layer.type !== "form") return;
    const fields = (layer as unknown as { fields: Array<Record<string, unknown>> }).fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fieldIdx) => {
      const rect = field.rect as { x: number; y: number; w: number; h: number } | undefined;
      if (!rect) return;
      const meta = field._meta as { added?: boolean; auto_detected?: boolean } | undefined;
      if (meta?.auto_detected && !showAutoDetected) return;
      const isAdded = !!meta?.added;
      const left = ptToPx(rect.x);
      const top = ptToPx(rect.y);
      const width = ptToPx(rect.w);
      const height = ptToPx(rect.h);
      const baseStyle: CSSProperties = {
        position: "absolute",
        left,
        top,
        width,
        height,
        boxSizing: "border-box",
        border: isAdded ? "1.5px solid var(--color-accent, #fcc46a)" : "1px solid #94a3b8",
        background: "rgba(255,255,255,0.92)",
        // Explicit ink color: the editor inherits a light text color
        // from the app shell which is invisible on the near-white field
        // background — typed text would only show when selected.
        color: "#111",
        caretColor: "#111",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: Math.max(10, Math.min(height * 0.7, 16)),
        padding: "0 4px",
        outline: "none",
      };
      if (field.kind === "checkbox") {
        elements.push(
          <input
            key={`${layerIdx}-${fieldIdx}`}
            type="checkbox"
            checked={!!field.value && field.value !== "Off" && field.value !== false}
            onChange={(e) => onUpdateField(layerIdx, fieldIdx, e.currentTarget.checked)}
            style={{ ...baseStyle, padding: 0, accentColor: "var(--color-accent, #fcc46a)" }}
            title={String(field.name ?? "")}
          />
        );
      } else if (field.kind === "radio") {
        const selected = !!field.value && field.value !== "Off" && field.value !== false;
        // Draw the radio with native browser look but scaled to the
        // widget rect. We can't use <input type="radio" name="..."> for
        // grouping because clicking one inside an existing group needs
        // to call our handler so the UDM sees the change.
        elements.push(
          <button
            key={`${layerIdx}-${fieldIdx}`}
            type="button"
            onClick={() => onSelectRadio(layerIdx, fieldIdx)}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height,
              boxSizing: "border-box",
              borderRadius: "50%",
              border: isAdded ? "1.5px solid var(--color-accent, #fcc46a)" : "1px solid #475569",
              background: "rgba(255,255,255,0.92)",
              padding: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title={`${String(field.name ?? "")}${selected ? " (selected)" : ""}`}
          >
            {selected ? (
              <span
                style={{
                  display: "block",
                  width: "55%",
                  height: "55%",
                  borderRadius: "50%",
                  background: "#111",
                }}
              />
            ) : null}
          </button>
        );
      } else {
        elements.push(
          <input
            key={`${layerIdx}-${fieldIdx}`}
            type="text"
            defaultValue={String(field.value ?? "")}
            onBlur={(e) => {
              const v = e.currentTarget.value;
              if (v !== String(field.value ?? "")) onUpdateField(layerIdx, fieldIdx, v);
            }}
            style={baseStyle}
            placeholder={String(field.name ?? "")}
            title={String(field.name ?? "")}
          />
        );
      }
    });
  });
  if (!elements.length) return null;
  return <>{elements}</>;
}

/** Render annotation layers on the Konva canvas. v1 supports
 * highlight (yellow translucent rect), comment (small icon marker), and
 * ink (polyline). All non-listening — annotations don't intercept text
 * clicks. */
function AnnotationNode({
  layer,
  scale,
}: {
  layer: { type: "annotation"; kind: string; data: unknown };
  scale: number;
}) {
  const kind = layer.kind;
  const data = (layer.data as Record<string, unknown>) || {};
  const ptToPx = (pt: number) => pt * (96 / 72) * scale;

  if (kind === "highlight") {
    const rect = (data.rect as Record<string, number> | undefined) ?? null;
    if (!rect) return null;
    const color = data.color as [number, number, number] | undefined;
    const fill =
      color && color.length >= 3
        ? `rgba(${color[0]},${color[1]},${color[2]},0.40)`
        : "rgba(255,235,59,0.40)";
    return (
      <KonvaRect
        x={ptToPx(rect.x)}
        y={ptToPx(rect.y)}
        width={ptToPx(rect.w)}
        height={ptToPx(rect.h)}
        fill={fill}
        listening={false}
      />
    );
  }

  if (kind === "comment") {
    const x = ptToPx(Number(data.x) || 0);
    const y = ptToPx(Number(data.y) || 0);
    const size = 16;
    return (
      <KonvaRect
        x={x}
        y={y}
        width={size}
        height={size}
        fill="#fcc46a"
        stroke="#a66b00"
        strokeWidth={1}
        listening={false}
      />
    );
  }

  if (kind === "ink") {
    const strokes = (data.strokes as number[][][] | undefined) ?? [];
    const color = (data.color as [number, number, number] | undefined) ?? [200, 0, 0];
    const width = (data.width as number | undefined) ?? 2;
    const stroke = `rgb(${color[0]},${color[1]},${color[2]})`;
    return (
      <>
        {strokes.map((s, i) => {
          const flat: number[] = [];
          for (const p of s) {
            if (p.length >= 2) flat.push(ptToPx(p[0]!), ptToPx(p[1]!));
          }
          if (flat.length < 4) return null;
          return (
            <KonvaLine
              key={i}
              points={flat}
              stroke={stroke}
              strokeWidth={width * scale}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />
          );
        })}
      </>
    );
  }
  return null;
}

function ImageReplaceButtons({
  page,
  scale,
  onReplaceImage,
  isLayerSelected,
}: {
  page: Page;
  scale: number;
  onReplaceImage: (imageId: string) => void;
  isLayerSelected: (layerIdx: number) => boolean;
}) {
  // These badges are positioned by scale but drawn at a fixed size, so on
  // a phone (pages fitted at ~0.35x) each one ends up bigger than the logo
  // it labels and blankets the body text — a document with a watermark and
  // four stamps gets five chips strewn across the page. Desktop keeps
  // them always-on; on mobile they appear only for a selected image, so
  // the document reads as a document until you ask to change something.
  const isMobile = useIsMobile();
  // One button per image resource per page, only for images big enough
  // to be worth replacing (skip bullet glyphs / icons).
  const seen = new Set<string>();
  const buttons: { imageId: string; left: number; top: number }[] = [];
  for (const [layerIdx, layer] of page.layers.entries()) {
    if (layer.type !== "image") continue;
    if (isMobile && !isLayerSelected(layerIdx)) continue;
    const wPt = layer.width.unit === "pt" ? layer.width.value : lengthToPx(layer.width) / (96 / 72);
    const hPt = layer.height.unit === "pt" ? layer.height.value : lengthToPx(layer.height) / (96 / 72);
    if (wPt < MIN_REPLACEABLE_PT || hPt < MIN_REPLACEABLE_PT) continue;
    if (seen.has(layer.image_id)) continue;
    seen.add(layer.image_id);
    buttons.push({
      imageId: layer.image_id,
      left: Math.max(2, lengthToPx(layer.x) * scale + 4),
      top: Math.max(2, lengthToPx(layer.y) * scale + 4),
    });
  }
  if (!buttons.length) return null;
  return (
    <>
      {buttons.map((b) => (
        <button
          key={b.imageId}
          onClick={() => onReplaceImage(b.imageId)}
          title={`Replace ${b.imageId}`}
          className={`absolute z-10 font-mono uppercase tracking-wider
                     bg-accent text-accent-fg border border-accent
                     hover:brightness-110 transition ${
                       isMobile
                         ? "text-xs px-3 h-11 flex items-center"
                         : "text-[0.6rem] px-1.5 py-0.5"
                     }`}
          style={{ left: b.left, top: b.top }}
        >
          ⟳ image
        </button>
      ))}
    </>
  );
}

function TextNodes({
  layer,
  layerIdx,
  pageIdx,
  resources,
  scale,
  editing,
  editedKeys,
  onStartEdit,
  onMoveRun,
}: {
  layer: UdmTextLayer;
  layerIdx: number;
  pageIdx: number;
  resources: Document["resources"];
  scale: number;
  editing: EditingState | null;
  editedKeys: ReadonlySet<string>;
  onStartEdit: (s: EditingState) => void;
  onMoveRun: (layerIdx: number, runIdx: number, xPt: number, yPt: number) => void;
}) {
  return (
    <>
      {layer.runs.map((run, runIdx) => {
        const beingEdited =
          editing?.pageIdx === pageIdx && editing.layerIdx === layerIdx && editing.runIdx === runIdx;
        if (beingEdited) return null;
        return (
          <TextRunNode
            key={runIdx}
            run={run}
            resources={resources}
            scale={scale}
            isEdited={editedKeys.has(runKey(pageIdx, layerIdx, runIdx))}
            onClick={() => onStartEdit({ pageIdx, layerIdx, runIdx, initialText: run.text })}
            onMove={(xPt, yPt) => onMoveRun(layerIdx, runIdx, xPt, yPt)}
          />
        );
      })}
    </>
  );
}

function setCursor(e: KonvaEventObject<MouseEvent>, cursor: string) {
  const stage = e.target.getStage();
  if (stage) stage.container().style.cursor = cursor;
}

function TextRunNode({
  run,
  resources,
  scale,
  isEdited,
  onClick,
  onMove,
}: {
  run: PositionedTextRun;
  resources: Document["resources"];
  scale: number;
  isEdited: boolean;
  onClick: () => void;
  onMove: (xPt: number, yPt: number) => void;
}) {
  const font = resources.fonts.find((f) => f.id === run.font_id);
  const x = lengthToPx(run.x) * scale;
  const y = lengthToPx(run.y) * scale;
  const fontSize = lengthToPx(run.font_size) * scale;
  const top = y - fontSize * BASELINE_TO_TOP;

  // Fit the glyphs to the width this run had on the source page. Konva
  // draws through the same canvas 2D context we measure with, so the
  // measurement matches what it will paint. Without this a substitute
  // font's advance widths decide the layout and runs collide or gap —
  // see fit-text.ts. Konva scales about the node origin, which for Text
  // is its top-left, so the run still starts exactly where the PDF put it.
  useFontsReady();
  const runScaleX = fitScaleX(
    run.text,
    sourceWidthPx(run, scale),
    // Konva's fontStyle holds weight and slant together ("bold italic"),
    // which is already valid ahead of the size in a CSS font shorthand.
    `${konvaFontStyle(font)} ${fontSize}px ${konvaFontFamily(font)}`,
    { shrinkOnly: !!run.ocr }
  );

  // Added runs are draggable — drag to reposition; click still edits.
  const draggable = !!run._meta?.added;
  const onDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const nx = e.target.x();
    const ny = e.target.y();
    const pxToPt = (px: number) => (px / scale) * (72 / 96);
    onMove(pxToPt(nx), pxToPt(ny + fontSize * BASELINE_TO_TOP));
  };

  // OCR runs sit on top of a scanned image that already shows the text.
  // Unedited: render an invisible-but-clickable hit rect (with a faint
  // hover affordance) so we don't double up text. Edited: mask the stale
  // pixels with an opaque rect and draw the new text on top.
  if (run.ocr) {
    const widthPt = run._meta?.ocr_width ?? run.text.length * lengthToPx(run.font_size) * 0.5;
    const w = widthPt * scale;
    const pad = fontSize * 0.15;
    if (!isEdited) {
      return (
        <KonvaRect
          x={x - pad}
          y={top - pad}
          width={w + pad * 2}
          height={fontSize + pad * 2}
          fill="#fcc46a"
          opacity={0.06}
          onClick={onClick}
          onTap={onClick}
          onMouseEnter={(e: KonvaEventObject<MouseEvent>) => {
            e.target.opacity(0.22);
            e.target.getLayer()?.batchDraw();
            setCursor(e, "text");
          }}
          onMouseLeave={(e: KonvaEventObject<MouseEvent>) => {
            e.target.opacity(0.06);
            e.target.getLayer()?.batchDraw();
            setCursor(e, "default");
          }}
        />
      );
    }
    return (
      <>
        <KonvaRect
          x={x - pad}
          y={top - pad}
          width={w + pad * 2}
          height={fontSize + pad * 2}
          fill="#ffffff"
          listening={false}
        />
        <KonvaText
          x={x}
          y={top}
          text={run.text}
          fontSize={fontSize}
          scaleX={runScaleX}
          fontFamily={konvaFontFamily(font)}
          fontStyle={konvaFontStyle(font)}
          textDecoration={run.underline ? "underline" : ""}
          fill={colorRefToCss(run.color, resources)}
          onClick={onClick}
          onTap={onClick}
          onMouseEnter={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "text")}
          onMouseLeave={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")}
        />
      </>
    );
  }

  return (
    <KonvaText
      x={x}
      y={top}
      text={run.text}
      fontSize={fontSize}
      scaleX={runScaleX}
      fontFamily={konvaFontFamily(font)}
      fontStyle={konvaFontStyle(font)}
      textDecoration={run.underline ? "underline" : ""}
      fill={colorRefToCss(run.color, resources)}
      rotation={run.rotation ?? 0}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onTap={onClick}
      onMouseEnter={(e: KonvaEventObject<MouseEvent>) => setCursor(e, draggable ? "move" : "text")}
      onMouseLeave={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")}
    />
  );
}

/** Eight-handle resize box around a bounding rect.
 *
 * Corner handles change x/y and width/height together (the opposite
 * corner stays fixed). Edge handles change one dimension. Shift held
 * on a corner drag locks the aspect ratio.
 *
 * Coordinates: caller passes a raw bbox in canvas pixels + scale, and
 * receives PDF-point values via onResize. Works for any layer type
 * with an (x, y, w, h) — image layers, rect shape layers, etc.
 */
function ResizeHandles({
  xPx: x,
  yPx: y,
  wPx: w,
  hPx: h,
  scale,
  onResize,
}: {
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
  scale: number;
  onResize: (xPt: number, yPt: number, wPt: number, hPt: number) => void;
}) {
  const pxToPt = (px: number) => (px / scale) * (72 / 96);

  // Bigger, grabbable handles on touch screens; tight on desktop.
  const isMobile = useIsMobile();
  const SIZE = isMobile ? 22 : 10;
  const HALF = SIZE / 2;
  // Minimum size in canvas pixels — prevents the box collapsing to a
  // point where the handles become un-grabbable.
  const MIN_PX = 8;

  type Anchor = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

  const anchors: { key: Anchor; x: number; y: number; cursor: string }[] = [
    { key: "nw", x: x, y: y, cursor: "nwse-resize" },
    { key: "n", x: x + w / 2, y: y, cursor: "ns-resize" },
    { key: "ne", x: x + w, y: y, cursor: "nesw-resize" },
    { key: "e", x: x + w, y: y + h / 2, cursor: "ew-resize" },
    { key: "se", x: x + w, y: y + h, cursor: "nwse-resize" },
    { key: "s", x: x + w / 2, y: y + h, cursor: "ns-resize" },
    { key: "sw", x: x, y: y + h, cursor: "nesw-resize" },
    { key: "w", x: x, y: y + h / 2, cursor: "ew-resize" },
  ];

  const applyDrag = (
    anchor: Anchor,
    dragX: number,
    dragY: number,
    shift: boolean
  ): { nx: number; ny: number; nw: number; nh: number } => {
    // dragX/dragY = handle's new top-left in stage px. Convert to its
    // logical centre (handles are SIZE×SIZE, drawn from top-left = x-HALF).
    const cx = dragX + HALF;
    const cy = dragY + HALF;

    let nx = x;
    let ny = y;
    let nw = w;
    let nh = h;
    const right = x + w;
    const bottom = y + h;

    switch (anchor) {
      case "nw":
        nx = Math.min(cx, right - MIN_PX);
        ny = Math.min(cy, bottom - MIN_PX);
        nw = right - nx;
        nh = bottom - ny;
        break;
      case "n":
        ny = Math.min(cy, bottom - MIN_PX);
        nh = bottom - ny;
        break;
      case "ne":
        nw = Math.max(cx - x, MIN_PX);
        ny = Math.min(cy, bottom - MIN_PX);
        nh = bottom - ny;
        break;
      case "e":
        nw = Math.max(cx - x, MIN_PX);
        break;
      case "se":
        nw = Math.max(cx - x, MIN_PX);
        nh = Math.max(cy - y, MIN_PX);
        break;
      case "s":
        nh = Math.max(cy - y, MIN_PX);
        break;
      case "sw":
        nx = Math.min(cx, right - MIN_PX);
        nw = right - nx;
        nh = Math.max(cy - y, MIN_PX);
        break;
      case "w":
        nx = Math.min(cx, right - MIN_PX);
        nw = right - nx;
        break;
    }

    // Shift on a corner = aspect-lock. Pick the larger relative delta
    // and apply it on both axes so the corner being dragged keeps
    // tracking the cursor as closely as possible.
    if (shift && (anchor === "nw" || anchor === "ne" || anchor === "se" || anchor === "sw")) {
      const aspect = w / h;
      if (nw / nh > aspect) {
        nh = nw / aspect;
      } else {
        nw = nh * aspect;
      }
      // Re-anchor: top/left edges only move when their handle is being dragged.
      if (anchor === "nw" || anchor === "sw") nx = right - nw;
      if (anchor === "nw" || anchor === "ne") ny = bottom - nh;
    }

    return { nx, ny, nw, nh };
  };

  return (
    <Group>
      <KonvaRect
        x={x}
        y={y}
        width={w}
        height={h}
        stroke="#5b9bd5"
        strokeWidth={1}
        dash={[4, 4]}
        listening={false}
      />
      {anchors.map((a) => (
        <KonvaRect
          key={a.key}
          x={a.x - HALF}
          y={a.y - HALF}
          width={SIZE}
          height={SIZE}
          fill="#ffffff"
          stroke="#5b9bd5"
          strokeWidth={1}
          draggable
          onMouseEnter={(e: KonvaEventObject<MouseEvent>) => setCursor(e, a.cursor)}
          onMouseLeave={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")}
          onDragMove={(e: KonvaEventObject<DragEvent>) => {
            const shift = (e.evt as MouseEvent).shiftKey;
            const { nx, ny, nw, nh } = applyDrag(a.key, e.target.x(), e.target.y(), shift);
            onResize(pxToPt(nx), pxToPt(ny), pxToPt(nw), pxToPt(nh));
          }}
          onDragEnd={(e: KonvaEventObject<DragEvent>) => {
            // Snap the handle back to its computed position — the layer
            // moved as we dragged, so the handle's stage position is now
            // wherever React last placed it via the parent re-render.
            const shift = (e.evt as MouseEvent).shiftKey;
            const { nx, ny, nw, nh } = applyDrag(a.key, e.target.x(), e.target.y(), shift);
            onResize(pxToPt(nx), pxToPt(ny), pxToPt(nw), pxToPt(nh));
          }}
        />
      ))}
    </Group>
  );
}

function ImageNode({
  layer,
  resources,
  scale,
  onMove,
  onSelect,
  isSelected,
  forceInteractive,
}: {
  layer: UdmImageLayer;
  resources: Document["resources"];
  scale: number;
  onMove: (xPt: number, yPt: number) => void;
  onSelect?: (additive: boolean) => void;
  isSelected?: boolean;
  forceInteractive?: boolean;
}) {
  const img = resources.images.find((i) => i.id === layer.image_id);
  const ref = img?.data_ref ?? "";
  const isOpaque = !ref || ref.startsWith("xref:");
  // No crossOrigin: we load images from the same origin (/uploads, /synthetic.assets).
  // Passing "anonymous" forces a CORS preflight that the Next.js static server
  // doesn't answer, so the load fails silently and the canvas shows nothing.
  const [image, status] = useImage(isOpaque ? "" : ref);

  const x = lengthToPx(layer.x) * scale;
  const y = lengthToPx(layer.y) * scale;
  const w = lengthToPx(layer.width) * scale;
  const h = lengthToPx(layer.height) * scale;

  // An "added" image (data: URL, no source xref) is draggable.
  const added = ref.startsWith("data:") && !(img?._meta as { xref?: number } | undefined)?.xref;
  const onDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const pxToPt = (px: number) => (px / scale) * (72 / 96);
    onMove(pxToPt(e.target.x()), pxToPt(e.target.y()));
  };

  if (!image) {
    // Distinct placeholders for loading vs failed so we can debug from the
    // browser: gray dashed = still loading; red dashed = failed/missing.
    const failed = status === "failed" || isOpaque;
    return (
      <KonvaRect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={failed ? "#fef2f2" : "#f5f5f5"}
        stroke={failed ? "#dc2626" : "#d4d4d4"}
        dash={[4, 4]}
        listening={false}
      />
    );
  }

  const img2 = (
    <KonvaImage
      image={image}
      x={x}
      y={y}
      width={w}
      height={h}
      rotation={layer.rotation ?? 0}
      opacity={layer.opacity ?? 1}
      // Existing images normally stay non-listening so clicks fall
      // through to text on top of them. `forceInteractive` (select tool)
      // overrides that so the user can pick them up to resize/delete.
      // Drag-to-move stays added-only — moving an existing image around
      // the canvas would corrupt the source layout silently.
      listening={added || !!forceInteractive}
      draggable={added}
      onDragEnd={added ? onDragEnd : undefined}
      onMouseDown={
        (added || forceInteractive) && onSelect
          ? (e: KonvaEventObject<MouseEvent>) => onSelect((e.evt as MouseEvent).shiftKey)
          : undefined
      }
      stroke={isSelected ? "#5b9bd5" : undefined}
      strokeWidth={isSelected ? 1 : 0}
      onMouseEnter={
        added
          ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "move")
          : forceInteractive
          ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "pointer")
          : undefined
      }
      onMouseLeave={
        added || forceInteractive
          ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")
          : undefined
      }
    />
  );

  // PDF clip path: restrict the image to its visible window. Without this
  // a photo placed with a large off-page transform (typical for Canva-style
  // designs) renders at full size instead of the intended small window.
  const clip = layer._meta?.clip;
  if (clip) {
    const ptToPx = (pt: number) => pt * (96 / 72) * scale;
    return (
      <Group
        clipX={ptToPx(clip.x)}
        clipY={ptToPx(clip.y)}
        clipWidth={ptToPx(clip.w)}
        clipHeight={ptToPx(clip.h)}
      >
        {img2}
      </Group>
    );
  }
  return img2;
}

function ShapeNode({
  layer,
  scale,
  interactive,
  isSelected,
  onClick,
}: {
  layer: UdmShapeLayer;
  scale: number;
  interactive?: boolean;
  isSelected?: boolean;
  onClick?: (additive: boolean) => void;
}) {
  const geom = layer.geometry as
    | { kind?: string; x?: never; y?: never; w?: never; h?: never; d?: string }
    | undefined;

  const fill = (layer.fill as { kind?: string; color?: never } | undefined) ?? undefined;
  const stroke =
    (layer.stroke as { paint?: { color?: never }; width?: never } | undefined) ?? undefined;

  const fillColor =
    fill?.kind === "solid" && fill.color ? colorRefToCss(fill.color, undefined) : undefined;
  const strokeColor = stroke?.paint?.color ? colorRefToCss(stroke.paint.color, undefined) : undefined;
  const strokeWidth = stroke?.width ? lengthToPx(stroke.width) * scale : 0;

  // Curved and multi-segment paths — rounded panels, callouts, rules.
  //
  // The importer has emitted these as kind="path" with an SVG d-string
  // since the lesson-12 work, and the exporter draws them. Both client
  // renderers still only handled kind="rect" and returned null for
  // everything else, under a comment claiming the importer captured
  // only rects. On a real 27-page document that silently dropped 217 of
  // 279 shapes: every page's white content panel vanished while the
  // coloured background behind it stayed, so the text rendered onto raw
  // blue or red and was all but unreadable.
  //
  // Konva's Path takes SVG data directly. The d-string is in absolute
  // page points, so the node sits at the origin and scales as a whole.
  if (geom?.kind === "path" && geom.d) {
    const s = (96 / 72) * scale;
    return (
      <KonvaPath
        data={geom.d}
        x={0}
        y={0}
        scaleX={s}
        scaleY={s}
        fill={fillColor}
        stroke={isSelected ? "#5b9bd5" : strokeColor}
        strokeWidth={strokeWidth ? strokeWidth / s : isSelected ? 1 / s : 0}
        opacity={layer.opacity ?? 1}
        listening={false}
      />
    );
  }

  if (geom?.kind !== "rect" || !geom.x || !geom.y || !geom.w || !geom.h) return null;

  const x = lengthToPx(geom.x) * scale;
  const y = lengthToPx(geom.y) * scale;
  const w = lengthToPx(geom.w) * scale;
  const h = lengthToPx(geom.h) * scale;

  return (
    <KonvaRect
      x={x}
      y={y}
      width={w}
      height={h}
      fill={fillColor}
      stroke={isSelected ? "#5b9bd5" : strokeColor}
      strokeWidth={isSelected ? Math.max(1, strokeWidth) : strokeWidth}
      opacity={layer.opacity ?? 1}
      listening={!!interactive}
      onMouseDown={
        interactive && onClick
          ? (e: KonvaEventObject<MouseEvent>) => onClick((e.evt as MouseEvent).shiftKey)
          : undefined
      }
      onMouseEnter={
        interactive
          ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "pointer")
          : undefined
      }
      onMouseLeave={
        interactive
          ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")
          : undefined
      }
    />
  );
}

/** rgb() background for masking an OCR run's stale pixels. */
function ocrBgCss(run: PositionedTextRun): string {
  const bg = run._meta?.ocr_bg;
  if (Array.isArray(bg) && bg.length >= 3) {
    return `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  }
  return "#ffffff";
}

function TextEditOverlay({
  state,
  page,
  doc,
  scale,
  onCommit,
  onCancel,
}: {
  state: EditingState;
  page: Page;
  doc: Document;
  scale: number;
  onCommit: (s: EditingState, commit: EditCommit) => void;
  onCancel: () => void;
}) {
  const layer = page.layers[state.layerIdx];
  const run = layer && layer.type === "text" ? layer.runs[state.runIdx] : null;
  const spanRef = useRef<HTMLSpanElement | null>(null);
  // Track the latest text on a ref so onBlur/onKeyDown can read it without
  // re-rendering the contentEditable (which would clobber the caret).
  const valueRef = useRef(state.initialText);

  const initialFont = run ? doc.resources.fonts.find((f) => f.id === run.font_id) : undefined;
  const [bold, setBold] = useState((initialFont?.weight ?? 400) >= 600);
  const [italic, setItalic] = useState(
    initialFont?.style === "italic" || initialFont?.style === "oblique"
  );
  const [underline, setUnderline] = useState(!!run?.underline);
  const [family, setFamily] = useState<FamilyClass>(familyClassOf(initialFont));
  const [sizePt, setSizePt] = useState(run ? Math.round(lengthToPt(run.font_size)) : 12);
  const initialColor = colorToHexAlpha(run?.color);
  const [colorHex, setColorHex] = useState(initialColor.hex);
  const [opacityPct, setOpacityPct] = useState(initialColor.alphaPct);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    el.textContent = state.initialText;
    valueRef.current = state.initialText;
    queueMicrotask(() => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  }, [state.initialText, state.pageIdx, state.layerIdx, state.runIdx]);

  const geom = useMemo(() => {
    if (!run) return null;
    const x = lengthToPx(run.x) * scale;
    const y = lengthToPx(run.y) * scale;
    const liveFs = sizePt * (96 / 72) * scale; // px at the chosen size
    const top = y - liveFs * BASELINE_TO_TOP;
    // The mask covers the *original* footprint, sized from the run's
    // stored size — it must not shrink when the user picks a smaller size.
    const origFs = lengthToPx(run.font_size) * scale;
    const origTop = y - origFs * BASELINE_TO_TOP;
    const widthPt =
      run._meta?.ocr_width ?? lengthToPt(run.font_size) * Math.max(run.text.length, 1) * 0.5;
    const maskW = widthPt * (96 / 72) * scale;
    return { x, top, liveFs, origTop, origFs, maskW };
  }, [run, scale, sizePt]);

  if (!run || !geom) return null;

  const commit = () => {
    // A no-op edit (opened a run and clicked away without changing
    // anything) must NOT mark the run edited — for OCR text that would
    // flip the crisp scan to the OCR transcription (which can misread
    // words). Only commit a real change.
    const unchanged =
      valueRef.current === state.initialText &&
      sizePt === Math.round(lengthToPt(run.font_size)) &&
      bold === ((initialFont?.weight ?? 400) >= 600) &&
      italic === (initialFont?.style === "italic" || initialFont?.style === "oblique") &&
      family === familyClassOf(initialFont) &&
      colorHex.toLowerCase() === initialColor.hex.toLowerCase() &&
      opacityPct === initialColor.alphaPct;
    if (unchanged) {
      onCancel();
      return;
    }
    onCommit(state, {
      text: valueRef.current,
      sizePt,
      bold,
      italic,
      underline,
      family,
      colorHex,
      opacityPct,
    });
  };

  const spanStyle: CSSProperties = {
    position: "absolute",
    left: geom.x,
    top: geom.top,
    fontSize: geom.liveFs,
    lineHeight: 1,
    fontFamily: FAMILY_CSS[family],
    fontWeight: bold ? 700 : 400,
    fontStyle: italic ? "italic" : "normal",
    color: (() => {
      const { r, g, b } = hexToRgb(colorHex);
      return `rgba(${r},${g},${b},${opacityPct / 100})`;
    })(),
    background: "transparent",
    outline: "1px solid var(--color-accent, #fcc46a)",
    outlineOffset: "1px",
    padding: 0,
    margin: 0,
    border: 0,
    whiteSpace: "pre",
    display: "inline-block",
    textDecoration: underline ? "underline" : "none",
    caretColor: "var(--color-accent, #fcc46a)",
  };

  // Toolbar sits above the edit box, or below it if there's no room.
  //
  // The offset has to clear the bar's OWN height, or its bottom edge lands
  // on the glyph tops and it reads as resting on the line being edited.
  // That is what a flat `- 30` did: the bar measures 30px, so it sat with
  // nothing at all between it and the text. Measure the bar rather than
  // counting up its Tailwind classes, so adding another control can never
  // silently close the gap again.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarH, setToolbarH] = useState(TOOLBAR_FALLBACK_H);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const measure = () => setToolbarH(el.offsetHeight || TOOLBAR_FALLBACK_H);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clearance = toolbarH + TOOLBAR_GAP;
  const toolbarTop =
    geom.top >= clearance ? geom.top - clearance : geom.top + geom.liveFs + TOOLBAR_GAP;
  // Suppress mousedown focus-steal so toolbar clicks don't blur (commit) the span.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  // On a phone the bar CANNOT float next to the text. Pages are fitted to
  // the screen (~0.35x), so a line renders a few pixels tall while the bar
  // stays ~26px — parking it 30px above the caret blankets several lines
  // around whatever you're editing, and users reported not being able to
  // see what they were typing. Dock it to the bottom edge instead, lifted
  // clear of the on-screen keyboard, which is where every mobile editor
  // puts it. Desktop keeps the floating behaviour, now clamped on-screen.
  const isMobile = useIsMobile();
  const kbInset = useKeyboardInset();
  // Eighteen controls don't fit a phone. Bold, italic and colour are what
  // people actually reach for; size, font and fade are not. Keep the
  // first three inline and put the rest behind one overflow, so the bar
  // is four thumb-sized targets rather than a strip that scrolls.
  const [moreOpen, setMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 36px: smaller than Apple's 44px minimum, which is the floor for a
  // lone control, but this is a dense cluster of five where every target
  // sits inside a predictable grid and nothing destructive is one tap
  // away. At 44px the bar dominated the screen. Below ~32px it stops
  // being reliably hittable, so this is as small as it should go.
  const tapSq = isMobile ? "w-9 h-9" : "w-6 h-6";
  const tapNarrow = isMobile ? "w-8 h-9" : "w-5 h-6";
  const tapChip = isMobile ? "px-2.5 h-9" : "px-1.5 h-6";
  const toolbarCls = isMobile
    ? "fixed z-30 flex flex-col items-stretch border border-border bg-surface px-2 py-1.5 shadow-lg max-w-full"
    : "absolute z-20 flex items-center gap-0.5 border border-border bg-surface px-1 py-0.5 shadow-lg max-w-[calc(100vw-1rem)] overflow-x-auto";
  const toolbarStyle: CSSProperties = isMobile
    ? { left: 8, right: 8, bottom: kbInset + 8 }
    : // Clamp so a run near the right edge can't push the bar off-screen.
      { left: Math.max(0, geom.x), top: toolbarTop };

  // iOS scrolls a newly focused field to just inside the visual viewport,
  // which can leave it sitting directly under the docked toolbar. Centre
  // it instead, once the keyboard animation has settled.
  useEffect(() => {
    if (!isMobile) return;
    const el = spanRef.current;
    if (!el) return;
    const t = window.setTimeout(
      () => el.scrollIntoView({ block: "center", behavior: "smooth" }),
      250
    );
    return () => window.clearTimeout(t);
  }, [isMobile]);

  return (
    <>
      {run.ocr ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: geom.x - geom.origFs * 0.15,
            top: geom.origTop - geom.origFs * 0.15,
            width: geom.maskW + geom.origFs * 0.3,
            height: geom.origFs * 1.3,
            background: ocrBgCss(run),
            pointerEvents: "none",
          }}
        />
      ) : null}

      <div ref={toolbarRef} className={toolbarCls} style={toolbarStyle}>
        {isMobile ? (
          <>
            <div className="flex items-center gap-1">
              <button
                onMouseDown={keepFocus}
                onClick={() => setBold((b) => !b)}
                aria-label="Bold"
                className={`font-mono text-sm font-bold ${tapSq} border shrink-0 ${
                  bold
                    ? "bg-accent text-accent-fg border-accent"
                    : "bg-transparent text-muted border-border"
                }`}
              >
                B
              </button>
              <button
                onMouseDown={keepFocus}
                onClick={() => setItalic((i) => !i)}
                aria-label="Italic"
                className={`font-mono text-sm italic ${tapSq} border shrink-0 ${
                  italic
                    ? "bg-accent text-accent-fg border-accent"
                    : "bg-transparent text-muted border-border"
                }`}
              >
                I
              </button>
              <button
                onMouseDown={keepFocus}
                onClick={() => setUnderline((u) => !u)}
                aria-label="Underline"
                className={`font-mono text-sm underline ${tapSq} border shrink-0 ${
                  underline
                    ? "bg-accent text-accent-fg border-accent"
                    : "bg-transparent text-muted border-border"
                }`}
              >
                U
              </button>
              <button
                onMouseDown={keepFocus}
                onClick={() => {
                  setPaletteOpen((v) => !v);
                  setMoreOpen(false);
                }}
                aria-label="Text colour"
                className={`${tapSq} border shrink-0 flex items-center justify-center ${
                  paletteOpen ? "border-accent" : "border-border"
                }`}
              >
                <span
                  className="w-5 h-5 border border-border"
                  style={{ background: colorHex }}
                />
              </button>
              <button
                onMouseDown={keepFocus}
                onClick={() => {
                  setMoreOpen((v) => !v);
                  setPaletteOpen(false);
                }}
                aria-label="More text options"
                className={`font-mono text-base ${tapSq} border shrink-0 ${
                  moreOpen
                    ? "bg-accent text-accent-fg border-accent"
                    : "bg-transparent text-muted border-border"
                }`}
              >
                ⋯
              </button>
            </div>

            {paletteOpen && (
              <div className="flex items-center gap-1 pt-1">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      setColorHex(c);
                      setPaletteOpen(false);
                    }}
                    aria-label={`Text colour ${c}`}
                    className={`flex-1 h-9 border ${
                      colorHex.toLowerCase() === c
                        ? "border-accent ring-1 ring-accent"
                        : "border-border"
                    }`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}

            {moreOpen && (
              <div className="pt-1 space-y-1">
                <div className="flex items-center gap-1">
                  <span className="label w-10 shrink-0">size</span>
                  <button
                    onMouseDown={keepFocus}
                    onClick={() => setSizePt((v) => Math.max(4, v - 1))}
                    className={`font-mono text-xs ${tapNarrow} border border-border text-muted`}
                  >
                    −
                  </button>
                  <span className="font-mono text-xs text-fg w-10 text-center tabular-nums">
                    {sizePt}
                  </span>
                  <button
                    onMouseDown={keepFocus}
                    onClick={() => setSizePt((v) => Math.min(300, v + 1))}
                    className={`font-mono text-xs ${tapNarrow} border border-border text-muted`}
                  >
                    +
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="label w-10 shrink-0">font</span>
                  {(["sans", "serif", "mono"] as FamilyClass[]).map((fc) => (
                    <button
                      key={fc}
                      onMouseDown={keepFocus}
                      onClick={() => setFamily(fc)}
                      className={`font-mono text-[0.6rem] uppercase flex-1 h-9 border ${
                        family === fc
                          ? "bg-accent text-accent-fg border-accent"
                          : "bg-transparent text-muted border-border"
                      }`}
                    >
                      {FAMILY_NAME[fc]}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <span className="label w-10 shrink-0">fade</span>
                  <button
                    onMouseDown={keepFocus}
                    onClick={() => setOpacityPct((o) => Math.max(10, o - 10))}
                    className={`font-mono text-xs ${tapNarrow} border border-border text-muted`}
                  >
                    −
                  </button>
                  <span className="font-mono text-xs text-fg w-12 text-center tabular-nums">
                    {opacityPct}%
                  </span>
                  <button
                    onMouseDown={keepFocus}
                    onClick={() => setOpacityPct((o) => Math.min(100, o + 10))}
                    className={`font-mono text-xs ${tapNarrow} border border-border text-muted`}
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
        <button
          onMouseDown={keepFocus}
          onClick={() => setBold((b) => !b)}
          title="Bold"
          className={`font-mono text-xs font-bold ${tapSq} border shrink-0 ${
            bold
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:text-fg"
          }`}
        >
          B
        </button>
        <button
          onMouseDown={keepFocus}
          onClick={() => setItalic((i) => !i)}
          title="Italic"
          className={`font-mono text-xs italic ${tapSq} border ml-0.5 shrink-0 ${
            italic
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:text-fg"
          }`}
        >
          I
        </button>
        <button
          onMouseDown={keepFocus}
          onClick={() => setUnderline((u) => !u)}
          title="Underline"
          className={`font-mono text-xs underline ${tapSq} border ml-0.5 shrink-0 ${
            underline
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:text-fg"
          }`}
        >
          U
        </button>
        <div className="flex items-center border border-border ml-1 shrink-0">
          <button
            onMouseDown={keepFocus}
            onClick={() => setSizePt((s) => Math.max(4, s - 1))}
            className={`font-mono text-xs ${tapNarrow} text-muted hover:text-fg shrink-0`}
          >
            −
          </button>
          <span className={`font-mono text-[0.65rem] ${isMobile ? "w-10" : "w-7"} text-center text-fg tabular-nums shrink-0`}>
            {sizePt}
          </span>
          <button
            onMouseDown={keepFocus}
            onClick={() => setSizePt((s) => Math.min(300, s + 1))}
            className={`font-mono text-xs ${tapNarrow} text-muted hover:text-fg shrink-0`}
          >
            +
          </button>
        </div>
        <div className="flex items-center ml-1 shrink-0">
          {(["sans", "serif", "mono"] as FamilyClass[]).map((fc) => (
            <button
              key={fc}
              onMouseDown={keepFocus}
              onClick={() => setFamily(fc)}
              title={FAMILY_NAME[fc]}
              className={`font-mono text-[0.6rem] uppercase ${tapChip} border shrink-0 ${
                family === fc
                  ? "bg-accent text-accent-fg border-accent"
                  : "bg-transparent text-muted border-border hover:text-fg"
              }`}
            >
              {fc[0]}
            </button>
          ))}
        </div>
        {/* Text colour swatches */}
        <div className="flex items-center gap-0.5 ml-1 shrink-0">
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              onMouseDown={keepFocus}
              onClick={() => setColorHex(c)}
              title={`Colour ${c}`}
              aria-label={`Text colour ${c}`}
              className={`${isMobile ? "w-9 h-11" : "w-4 h-5"} border shrink-0 ${
                colorHex.toLowerCase() === c
                  ? "border-accent ring-1 ring-accent"
                  : "border-border"
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        {/* Opacity stepper */}
        <div className="flex items-center border border-border ml-1 shrink-0" title="Text opacity">
          <button
            onMouseDown={keepFocus}
            onClick={() => setOpacityPct((o) => Math.max(10, o - 10))}
            className={`font-mono text-xs ${tapNarrow} text-muted hover:text-fg shrink-0`}
          >
            −
          </button>
          <span className={`font-mono text-[0.6rem] ${isMobile ? "w-12" : "w-8"} text-center text-fg tabular-nums shrink-0`}>
            {opacityPct}%
          </span>
          <button
            onMouseDown={keepFocus}
            onClick={() => setOpacityPct((o) => Math.min(100, o + 10))}
            className={`font-mono text-xs ${tapNarrow} text-muted hover:text-fg shrink-0`}
          >
            +
          </button>
        </div>
          </>
        )}
      </div>

      <span
        ref={spanRef}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => {
          valueRef.current = e.currentTarget.textContent ?? "";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={commit}
        style={spanStyle}
      />
    </>
  );
}

const MODE_HINT: Record<EditorMode, string> = {
  none: "click any text to edit · enter to commit · esc to cancel",
  select: "click any image or shape to select · drag handles to resize · shift to multi-select",
  "region-image": "drag a box over the area to replace, then pick an image",
  recolor: "click any shape to recolor it",
  "add-text": "click where you want the new text",
  "add-image": "click where you want the new image, then pick a file",
  "add-rect": "drag a box to draw a rectangle",
  highlight: "drag over text to highlight it",
  comment: "click where you want a sticky-note comment",
  ink: "draw freehand — mouse-up commits the stroke",
  "add-field-text": "click where you want the new text field",
  "add-field-checkbox": "click where you want the new checkbox",
  "add-field-radio": "click to place a radio in the current group · pick the group from the tools row",
  "lift-region":
    "drag a box around a signature or stamp — it's lifted with a transparent background into the library",
};

function EditorHeader({
  scale,
  onScaleChange,
  onFit,
  mode,
  onToggleMode,
  layout,
  onLayoutChange,
  autoDetectedCount,
  showAutoDetected,
  onToggleAutoDetected,
  canExtractToLibrary,
  onExtractToLibrary,
  imageOpacityPct,
  onImageOpacityChange,
  libraryCount,
  libraryOpen,
  onToggleLibrary,
  tipsOpen,
  onToggleTips,
  searchOpen,
  onToggleSearch,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
  onFit: () => void;
  mode: EditorMode;
  onToggleMode: (m: EditorMode) => void;
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
  autoDetectedCount: number;
  showAutoDetected: boolean;
  onToggleAutoDetected: () => void;
  canExtractToLibrary: boolean;
  onExtractToLibrary: () => void;
  /** 0–100 for the single selected image, or null when none is selected. */
  imageOpacityPct: number | null;
  onImageOpacityChange: (pct: number) => void;
  libraryCount: number;
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  tipsOpen: boolean;
  onToggleTips: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
}) {
  const isMobile = useIsMobile();
  // The tool palette is collapsed by default on a phone. The default
  // interaction here needs no tool at all — you tap text and type — so
  // the screen should open showing the document and one plain
  // instruction, not thirteen glyph buttons in a strip you can only
  // read five of at a time.
  const [toolsOpen, setToolsOpen] = useState(false);
  const modeBtn = (active: boolean) =>
    `font-mono text-xs px-2 py-1 border transition-colors shrink-0 whitespace-nowrap ${
      active
        ? "bg-accent text-accent-fg border-accent"
        : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
    }`;
  // Same visual language, sized for a thumb: 44px is the minimum target.
  const tapBtn = (active: boolean) =>
    `font-mono text-xs px-3 h-11 inline-flex items-center justify-center border transition-colors whitespace-nowrap ${
      active
        ? "bg-accent text-accent-fg border-accent"
        : "bg-transparent text-muted border-border"
    }`;
  // Tools grouped by intent so the dense row is scannable. Glyphs are
  // unique within the row (the old "add rect" and "text field" both used
  // ▭ — text field is now a distinct "T").
  const toolGroups: { group: string; items: { m: EditorMode; label: string }[] }[] = [
    {
      group: "content",
      items: [
        { m: "select", label: "⬚ select" },
        { m: "add-text", label: "✎ add text" },
        { m: "add-image", label: "🖼 add image" },
        { m: "add-rect", label: "▭ rectangle" },
        { m: "recolor", label: "◐ recolor" },
        { m: "region-image", label: "⊕ replace region" },
        { m: "lift-region", label: "✂ lift" },
      ],
    },
    {
      group: "annotate",
      items: [
        { m: "highlight", label: "▮ highlight" },
        { m: "comment", label: "💬 comment" },
        { m: "ink", label: "✒ ink" },
      ],
    },
    {
      group: "form fields",
      items: [
        { m: "add-field-text", label: "T text field" },
        { m: "add-field-checkbox", label: "☐ checkbox" },
        { m: "add-field-radio", label: "◉ radio" },
      ],
    },
  ];
  if (isMobile) {
    const sessionBits = [
      canExtractToLibrary && (
        <button key="extract" onClick={onExtractToLibrary} className={tapBtn(false)}>
          ↥ add to library
        </button>
      ),
      <button key="lib" onClick={onToggleLibrary} className={tapBtn(libraryOpen)}>
        library ({libraryCount})
      </button>,
      autoDetectedCount > 0 && (
        <button key="af" onClick={onToggleAutoDetected} className={tapBtn(showAutoDetected)}>
          {showAutoDetected ? "hide" : "show"} {autoDetectedCount} detected field
          {autoDetectedCount === 1 ? "" : "s"}
        </button>
      ),
      <button key="tips" onClick={onToggleTips} className={tapBtn(tipsOpen)}>
        ? tips
      </button>,
    ].filter(Boolean);

    return (
      <div className="border border-border bg-surface">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <ZoomControl scale={scale} onScaleChange={onScaleChange} onFit={onFit} />
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              onClick={() => onLayoutChange("list")}
              className={tapBtn(layout === "list")}
              title="Single-column reading view"
            >
              ☰
            </button>
            <button
              onClick={() => onLayoutChange("grid")}
              className={tapBtn(layout === "grid")}
              title="Thumbnail grid of all pages"
            >
              ▦
            </button>
          </div>
        </div>

        {/* The two things a phone user actually reaches for. */}
        <div className="flex items-stretch gap-2 px-3 py-2">
          <button
            onClick={() => setToolsOpen((v) => !v)}
            className={`flex-1 ${tapBtn(toolsOpen)}`}
          >
            {toolsOpen ? "✕ close tools" : "⊞ tools"}
          </button>
          <button
            onClick={onToggleSearch}
            className={`flex-1 ${tapBtn(searchOpen)}`}
          >
            🔍 find
          </button>
        </div>

        {/* One plain sentence beats thirteen glyphs. */}
        {!toolsOpen && (
          <p className="px-3 pb-2 font-mono text-[0.65rem] text-subtle">
            {mode === "none" ? "tap any text to edit it" : MODE_HINT[mode]}
          </p>
        )}

        {/* Everything visible at once — nothing hidden off the edge. */}
        {toolsOpen && (
          <div className="border-t border-border px-3 py-3 space-y-3">
            {toolGroups.map((g) => (
              <div key={g.group}>
                <div className="label mb-1.5">{g.group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map((t) => (
                    <button
                      key={t.m}
                      onClick={() => {
                        onToggleMode(t.m);
                        setToolsOpen(false);
                      }}
                      className={tapBtn(mode === t.m)}
                      title={MODE_HINT[t.m]}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <div className="label mb-1.5">session</div>
              <div className="flex flex-wrap gap-1.5">{sessionBits}</div>
            </div>
          </div>
        )}

        {/* Contextual: only while an image is selected. */}
        {imageOpacityPct !== null && (
          <label className="flex items-center gap-2 px-3 py-2 border-t border-border">
            <span className="label shrink-0">opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={imageOpacityPct}
              onChange={(e) => onImageOpacityChange(Number(e.target.value))}
              className="flex-1 accent-accent"
              aria-label="Image opacity"
            />
            <span className="font-mono text-xs text-muted w-9 text-right tabular-nums">
              {imageOpacityPct}%
            </span>
          </label>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-surface px-3 py-2 flex-wrap">
      {/* On phones the tool row scrolls horizontally in a single line
          instead of wrapping into several rows above the document. */}
      <div className="flex items-center gap-1 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-visible max-w-full">
        <ZoomControl scale={scale} onScaleChange={onScaleChange} onFit={onFit} />
        <span className="label mx-2 shrink-0">view</span>
        <button
          onClick={() => onLayoutChange("list")}
          className={modeBtn(layout === "list")}
          title="Single-column reading view at full zoom"
        >
          ☰ list
        </button>
        <button
          onClick={() => onLayoutChange("grid")}
          className={modeBtn(layout === "grid")}
          title="Thumbnail grid of all pages"
        >
          ▦ grid
        </button>
        {toolGroups.flatMap((g) => [
          <span
            key={`grp-${g.group}`}
            className="label mx-2 border-l border-border pl-2 shrink-0 whitespace-nowrap"
          >
            {g.group}
          </span>,
          ...g.items.map((t) => (
            <button
              key={t.m}
              onClick={() => onToggleMode(t.m)}
              className={modeBtn(mode === t.m)}
              title={MODE_HINT[t.m]}
            >
              {t.label}
            </button>
          )),
        ])}
      </div>
      <div className="flex items-center gap-3">
        {imageOpacityPct !== null ? (
          <label
            className="flex items-center gap-1.5 shrink-0"
            title="Fade the selected image. Drop it low to turn a logo back into a background watermark."
          >
            <span className="label whitespace-nowrap">opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={imageOpacityPct}
              onChange={(e) => onImageOpacityChange(Number(e.target.value))}
              className="w-24 accent-accent"
              aria-label="Image opacity"
            />
            <span className="font-mono text-xs text-muted w-9 text-right tabular-nums">
              {imageOpacityPct}%
            </span>
          </label>
        ) : null}
        {canExtractToLibrary ? (
          <button
            onClick={onExtractToLibrary}
            className={modeBtn(false)}
            title="Extract the selected image into the session library for reuse"
          >
            ↥ library
          </button>
        ) : null}
        <button
          onClick={onToggleLibrary}
          className={modeBtn(libraryOpen)}
          title="Session image library — lifted signatures/stamps + imported images"
        >
          {libraryOpen ? "▼" : "▶"} library ({libraryCount})
        </button>
        {autoDetectedCount > 0 ? (
          <button
            onClick={onToggleAutoDetected}
            className={modeBtn(showAutoDetected)}
            title="Auto-detect treats long rect strokes as text-field blanks and small squares as checkboxes. Disable when the document isn't actually a form."
          >
            {showAutoDetected ? "✓" : "○"} auto-fields ({autoDetectedCount})
          </button>
        ) : null}
        <button
          onClick={onToggleSearch}
          className={modeBtn(searchOpen)}
          title="Find text in document (Ctrl+F)"
        >
          🔍 find
        </button>
        <button
          onClick={onToggleTips}
          className={modeBtn(tipsOpen)}
          title="Show editing tips"
        >
          ? tips
        </button>
        <div className="label text-muted">{MODE_HINT[mode]}</div>
      </div>
    </div>
  );
}
