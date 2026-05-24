"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Image as KonvaImage, Layer, Line as KonvaLine, Rect as KonvaRect, Stage, Text as KonvaText } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import useImage from "use-image";

import { ZoomControl } from "./ZoomControl";

import {
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
} from "@/lib/udm";

type FamilyClass = "sans" | "serif" | "mono";

/** The one active editor tool. "none" = plain click-to-edit text. */
type EditorMode =
  | "none"
  | "region-image"
  | "recolor"
  | "add-text"
  | "add-image"
  | "highlight"
  | "comment"
  | "ink"
  | "add-field-text"
  | "add-field-checkbox";

/** What a text edit commits: the new string plus its formatting. */
interface EditCommit {
  text: string;
  sizePt: number;
  bold: boolean;
  family: FamilyClass;
}

const FAMILY_NAME: Record<FamilyClass, string> = {
  sans: "sans-serif",
  serif: "serif",
  mono: "monospace",
};

const FAMILY_CSS: Record<FamilyClass, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'Courier New', monospace",
};

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

/** Find or create a substituted FontResource for (family, weight) on a
 * mutable doc clone. Returns its id. */
function ensureFont(doc: Document, family: FamilyClass, weight: number): string {
  const familyName = FAMILY_NAME[family];
  const existing = doc.resources.fonts.find(
    (f) => f.family === familyName && f.weight === weight && f.style === "normal"
  );
  if (existing) return existing.id;
  const id = `font_user_${family}_${weight}`;
  if (!doc.resources.fonts.some((f) => f.id === id)) {
    doc.resources.fonts.push({
      id,
      family: familyName,
      weight,
      style: "normal",
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
 * swapped — the rest of the image is preserved. */
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
  ctx.drawImage(overlay, region.x, region.y, region.w, region.h);
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
  // FontFaceStyles in UdmViewer injects @font-face for udm-<id>.
  return `udm-${font.id}, ${font.family.includes(" ") ? `"${font.family}"` : font.family}, sans-serif`;
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
  const [editing, setEditing] = useState<EditingState | null>(null);
  // Runs whose text the user has changed this session. Used so OCR runs
  // (invisible by default — the scanned image shows the text) flip to
  // visible once edited, masking the stale pixels underneath.
  const [editedKeys, setEditedKeys] = useState<ReadonlySet<string>>(new Set());

  const updateRun = useCallback(
    (pageIdx: number, layerIdx: number, runIdx: number, commit: EditCommit) => {
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      const layer = content.pages[pageIdx]!.layers[layerIdx]!;
      if (layer.type !== "text") return;
      const run = layer.runs[runIdx]!;
      run.text = commit.text;
      run.font_size = { value: commit.sizePt, unit: "pt" };
      // Bold + family are expressed by pointing the run at a substituted
      // FontResource of the right weight/family. The exporters resolve
      // font_id -> FontResource -> a bundled metric-compatible font.
      run.font_id = ensureFont(next, commit.family, commit.bold ? 700 : 400);
      setEditedKeys((prev) => new Set(prev).add(runKey(pageIdx, layerIdx, runIdx)));
      onChange(next, `edit-text-${pageIdx}-${layerIdx}-${runIdx}`);
    },
    [doc, onChange]
  );

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
  const recolorMode = mode === "recolor";
  const addTextMode = mode === "add-text";
  const addImageMode = mode === "add-image";
  const highlightMode = mode === "highlight";
  const commentMode = mode === "comment";
  const inkMode = mode === "ink";
  const addFieldTextMode = mode === "add-field-text";
  const addFieldCheckboxMode = mode === "add-field-checkbox";
  const toggleMode = (m: EditorMode) => setMode((cur) => (cur === m ? "none" : m));
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

  const addFormField = useCallback(
    (pageIdx: number, kind: "text" | "checkbox", cx: number, cy: number) => {
      const next = structuredClone(doc) as Document;
      const page = (next.content as FixedContent).pages[pageIdx];
      if (!page) return;
      const k = (72 / 96) / scale;
      const xPt = cx * k;
      const yPt = cy * k;
      const sizePt =
        kind === "checkbox"
          ? { w: 14, h: 14 }
          : { w: 200, h: 22 };
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
        name: `field_user_${Date.now()}_${idx}`,
        rect: { x: xPt, y: yPt, w: sizePt.w, h: sizePt.h },
        value: kind === "checkbox" ? false : "",
        _meta: { added: true },
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

  return (
    <div className="space-y-4">
      <EditorHeader
        scale={scale}
        onScaleChange={setScale}
        mode={mode}
        onToggleMode={toggleMode}
        layout={layout}
        onLayoutChange={(l) => {
          setLayout(l);
          // Give each mode a sensible default zoom so the switch is
          // visible: grid drops to a thumbnail zoom, list returns to 100%.
          setScale((s) => (l === "grid" && s > 0.5 ? 0.4 : l === "list" && s < 0.5 ? 1 : s));
        }}
      />
      <PageOpsPanel doc={doc} onChange={onChange} />
      <div
        className={
          (layout === "grid"
            ? "flex flex-wrap justify-center gap-6"
            : "space-y-6 flex flex-col items-center") +
          " overflow-y-auto overflow-x-auto border border-border bg-bg/40 p-4"
        }
        style={{ maxHeight: "75vh" }}
      >
        {fixed.pages.map((page, pageIdx) => (
          <div key={page.number}>
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
              recolorMode={recolorMode}
              addTextMode={addTextMode}
              addImageMode={addImageMode}
              highlightMode={highlightMode}
              commentMode={commentMode}
              inkMode={inkMode}
              addFieldTextMode={addFieldTextMode}
              addFieldCheckboxMode={addFieldCheckboxMode}
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
              onMoveRun={(layerIdx, runIdx, xPt, yPt) =>
                moveRun(pageIdx, layerIdx, runIdx, xPt, yPt)
              }
              onMoveImage={(layerIdx, xPt, yPt) => moveImageLayer(pageIdx, layerIdx, xPt, yPt)}
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

  const act =
    "font-mono text-xs px-2 py-1 border border-border text-muted hover:text-fg hover:border-fg disabled:opacity-25 disabled:hover:text-muted disabled:hover:border-border";

  return (
    <div className="border border-border bg-surface px-3 py-2 flex items-center gap-2 flex-wrap">
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
  onAddField,
  onUpdateField,
  onMoveRun,
  onMoveImage,
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
  onAddField: (kind: "text" | "checkbox", cx: number, cy: number) => void;
  onUpdateField: (layerIdx: number, fieldIdx: number, value: unknown) => void;
  onMoveRun: (layerIdx: number, runIdx: number, xPt: number, yPt: number) => void;
  onMoveImage: (layerIdx: number, xPt: number, yPt: number) => void;
}) {
  const w = lengthToPx(page.width) * scale;
  const h = lengthToPx(page.height) * scale;
  // Layer paint-order classification operates in PDF points (UDM source units).
  const pageWPt = page.width.unit === "pt" ? page.width.value : lengthToPx(page.width) / (96 / 72);
  const pageHPt = page.height.unit === "pt" ? page.height.value : lengthToPx(page.height) / (96 / 72);

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
      <Stage width={w} height={h}>
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
                return (
                  <ShapeNode
                    key={layerIdx}
                    layer={layer}
                    scale={scale}
                    interactive={recolorMode}
                    onClick={recolorMode ? () => onRecolorShape(layerIdx) : undefined}
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
      <FormFieldsOverlay page={page} scale={scale} onUpdateField={onUpdateField} />
      {!placeMode &&
      !addTextMode &&
      !addImageMode &&
      !highlightMode &&
      !commentMode &&
      !inkMode &&
      !addFieldTextMode &&
      !addFieldCheckboxMode ? (
        <ImageReplaceButtons page={page} scale={scale} onReplaceImage={onReplaceImage} />
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
}: {
  page: Page;
  scale: number;
  onUpdateField: (layerIdx: number, fieldIdx: number, value: unknown) => void;
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
      const isAdded = !!(field._meta as { added?: boolean } | undefined)?.added;
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
}: {
  page: Page;
  scale: number;
  onReplaceImage: (imageId: string) => void;
}) {
  // One button per image resource per page, only for images big enough
  // to be worth replacing (skip bullet glyphs / icons).
  const seen = new Set<string>();
  const buttons: { imageId: string; left: number; top: number }[] = [];
  for (const layer of page.layers) {
    if (layer.type !== "image") continue;
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
          className="absolute z-10 font-mono text-[0.6rem] uppercase tracking-wider px-1.5 py-0.5
                     bg-accent text-accent-fg border border-accent
                     hover:brightness-110 transition"
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
          fontFamily={konvaFontFamily(font)}
          fontStyle={konvaFontStyle(font)}
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
      fontFamily={konvaFontFamily(font)}
      fontStyle={konvaFontStyle(font)}
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

function ImageNode({
  layer,
  resources,
  scale,
  onMove,
}: {
  layer: UdmImageLayer;
  resources: Document["resources"];
  scale: number;
  onMove: (xPt: number, yPt: number) => void;
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
      // Only added images are interactive (draggable). Existing images
      // stay non-listening so clicks fall through to text on top of them
      // (off-page / oversized images otherwise swallow those clicks).
      listening={added}
      draggable={added}
      onDragEnd={added ? onDragEnd : undefined}
      onMouseEnter={
        added ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "move") : undefined
      }
      onMouseLeave={
        added ? (e: KonvaEventObject<MouseEvent>) => setCursor(e, "default") : undefined
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
  onClick,
}: {
  layer: UdmShapeLayer;
  scale: number;
  interactive?: boolean;
  onClick?: () => void;
}) {
  const geom = layer.geometry as
    | { kind?: string; x?: never; y?: never; w?: never; h?: never }
    | undefined;
  if (geom?.kind !== "rect" || !geom.x || !geom.y || !geom.w || !geom.h) return null;

  const x = lengthToPx(geom.x) * scale;
  const y = lengthToPx(geom.y) * scale;
  const w = lengthToPx(geom.w) * scale;
  const h = lengthToPx(geom.h) * scale;

  const fill = (layer.fill as { kind?: string; color?: never } | undefined) ?? undefined;
  const stroke =
    (layer.stroke as { paint?: { color?: never }; width?: never } | undefined) ?? undefined;

  const fillColor =
    fill?.kind === "solid" && fill.color ? colorRefToCss(fill.color, undefined) : undefined;
  const strokeColor = stroke?.paint?.color ? colorRefToCss(stroke.paint.color, undefined) : undefined;
  const strokeWidth = stroke?.width ? lengthToPx(stroke.width) * scale : 0;

  return (
    <KonvaRect
      x={x}
      y={y}
      width={w}
      height={h}
      fill={fillColor}
      stroke={strokeColor}
      strokeWidth={strokeWidth}
      opacity={layer.opacity ?? 1}
      listening={!!interactive}
      onClick={onClick}
      onTap={onClick}
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
  const [family, setFamily] = useState<FamilyClass>(familyClassOf(initialFont));
  const [sizePt, setSizePt] = useState(run ? Math.round(lengthToPt(run.font_size)) : 12);

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

  const commit = () => onCommit(state, { text: valueRef.current, sizePt, bold, family });

  const spanStyle: CSSProperties = {
    position: "absolute",
    left: geom.x,
    top: geom.top,
    fontSize: geom.liveFs,
    lineHeight: 1,
    fontFamily: FAMILY_CSS[family],
    fontWeight: bold ? 700 : 400,
    color: colorRefToCss(run.color, doc.resources),
    background: "transparent",
    outline: "1px solid var(--color-accent, #fcc46a)",
    outlineOffset: "1px",
    padding: 0,
    margin: 0,
    border: 0,
    whiteSpace: "pre",
    display: "inline-block",
    caretColor: "var(--color-accent, #fcc46a)",
  };

  // Toolbar sits above the edit box, or below it if there's no room.
  const toolbarTop = geom.top >= 32 ? geom.top - 30 : geom.top + geom.liveFs + 6;
  // Suppress mousedown focus-steal so toolbar clicks don't blur (commit) the span.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

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

      <div
        className="absolute z-20 flex items-center gap-0.5 border border-border bg-surface px-1 py-0.5 shadow-lg"
        style={{ left: geom.x, top: toolbarTop }}
      >
        <button
          onMouseDown={keepFocus}
          onClick={() => setBold((b) => !b)}
          title="Bold"
          className={`font-mono text-xs font-bold w-6 h-6 border ${
            bold
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:text-fg"
          }`}
        >
          B
        </button>
        <div className="flex items-center border border-border ml-1">
          <button
            onMouseDown={keepFocus}
            onClick={() => setSizePt((s) => Math.max(4, s - 1))}
            className="font-mono text-xs w-5 h-6 text-muted hover:text-fg"
          >
            −
          </button>
          <span className="font-mono text-[0.65rem] w-7 text-center text-fg tabular-nums">
            {sizePt}
          </span>
          <button
            onMouseDown={keepFocus}
            onClick={() => setSizePt((s) => Math.min(300, s + 1))}
            className="font-mono text-xs w-5 h-6 text-muted hover:text-fg"
          >
            +
          </button>
        </div>
        <div className="flex items-center ml-1">
          {(["sans", "serif", "mono"] as FamilyClass[]).map((fc) => (
            <button
              key={fc}
              onMouseDown={keepFocus}
              onClick={() => setFamily(fc)}
              title={FAMILY_NAME[fc]}
              className={`font-mono text-[0.6rem] uppercase px-1.5 h-6 border ${
                family === fc
                  ? "bg-accent text-accent-fg border-accent"
                  : "bg-transparent text-muted border-border hover:text-fg"
              }`}
            >
              {fc[0]}
            </button>
          ))}
        </div>
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
  "region-image": "drag a box over the area to replace, then pick an image",
  recolor: "click any shape to recolor it",
  "add-text": "click where you want the new text",
  "add-image": "click where you want the new image, then pick a file",
  highlight: "drag over text to highlight it",
  comment: "click where you want a sticky-note comment",
  ink: "draw freehand — mouse-up commits the stroke",
  "add-field-text": "click where you want the new text field",
  "add-field-checkbox": "click where you want the new checkbox",
};

function EditorHeader({
  scale,
  onScaleChange,
  mode,
  onToggleMode,
  layout,
  onLayoutChange,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
  mode: EditorMode;
  onToggleMode: (m: EditorMode) => void;
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
}) {
  const modeBtn = (active: boolean) =>
    `font-mono text-xs px-2 py-1 border transition-colors ${
      active
        ? "bg-accent text-accent-fg border-accent"
        : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
    }`;
  const tools: { m: EditorMode; label: string }[] = [
    { m: "add-text", label: "✎ add text" },
    { m: "add-image", label: "🖼 add image" },
    { m: "recolor", label: "◐ recolor shape" },
    { m: "region-image", label: "⊕ replace region" },
    { m: "highlight", label: "▮ highlight" },
    { m: "comment", label: "💬 comment" },
    { m: "ink", label: "✒ ink" },
    { m: "add-field-text", label: "▭ text field" },
    { m: "add-field-checkbox", label: "☐ checkbox" },
  ];
  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-surface px-3 py-2 flex-wrap">
      <div className="flex items-center gap-1 flex-wrap">
        <ZoomControl scale={scale} onScaleChange={onScaleChange} />
        <span className="label mx-2">view</span>
        <button onClick={() => onLayoutChange("list")} className={modeBtn(layout === "list")}>
          ☰ list
        </button>
        <button onClick={() => onLayoutChange("grid")} className={modeBtn(layout === "grid")}>
          ▦ grid
        </button>
        <span className="label mx-2">tools</span>
        {tools.map((t) => (
          <button key={t.m} onClick={() => onToggleMode(t.m)} className={modeBtn(mode === t.m)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="label text-muted">{MODE_HINT[mode]}</div>
    </div>
  );
}
