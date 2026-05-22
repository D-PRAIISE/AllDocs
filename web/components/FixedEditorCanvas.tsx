"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Rect as KonvaRect, Stage, Text as KonvaText } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import useImage from "use-image";

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
  onChange: (next: Document) => void;
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
      onChange(next);
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

  const [placeMode, setPlaceMode] = useState(false);

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
        setPlaceMode(false);
        return;
      }

      const resource = doc.resources.images.find((i) => i.id === base!.image_id);
      if (!resource || !resource.data_ref || resource.data_ref.startsWith("xref:")) {
        setPlaceMode(false);
        return;
      }

      const picked = await pickImageFile();
      if (!picked) {
        setPlaceMode(false);
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
        setPlaceMode(false);
      }
    },
    [doc, onChange, scale]
  );

  return (
    <div className="space-y-4">
      <EditorHeader
        scale={scale}
        onScaleChange={setScale}
        placeMode={placeMode}
        onTogglePlaceMode={() => setPlaceMode((p) => !p)}
      />
      <div className="space-y-6 flex flex-col items-center">
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
              onStartEdit={setEditing}
              onCancelEdit={() => setEditing(null)}
              onCommitEdit={(state, commit) => {
                updateRun(state.pageIdx, state.layerIdx, state.runIdx, commit);
                setEditing(null);
              }}
              onReplaceImage={replaceImage}
              onPlaceRegion={(rect) => placeImageInRegion(pageIdx, rect)}
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
}) {
  const w = lengthToPx(page.width) * scale;
  const h = lengthToPx(page.height) * scale;
  // Layer paint-order classification operates in PDF points (UDM source units).
  const pageWPt = page.width.unit === "pt" ? page.width.value : lengthToPx(page.width) / (96 / 72);
  const pageHPt = page.height.unit === "pt" ? page.height.value : lengthToPx(page.height) / (96 / 72);

  return (
    <div className="relative bg-white border border-border" style={{ width: w, height: h }}>
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
                return <ShapeNode key={layerIdx} layer={layer} scale={scale} />;
              }
              if (layer.type === "image") {
                return <ImageNode key={layerIdx} layer={layer} resources={doc.resources} scale={scale} />;
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
                  />
                );
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
      {placeMode ? (
        <RegionSelectOverlay onComplete={onPlaceRegion} />
      ) : (
        <ImageReplaceButtons page={page} scale={scale} onReplaceImage={onReplaceImage} />
      )}
    </div>
  );
}

/** Full-page transparent overlay active in "place image" mode. The user
 * drags a rectangle; on release it's reported (canvas px) so the caller
 * can composite a picked image into that region. */
function RegionSelectOverlay({
  onComplete,
}: {
  onComplete: (rect: { x: number; y: number; w: number; h: number }) => void;
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
          className="absolute border-2 border-accent bg-accent/15 pointer-events-none"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      ) : null}
    </div>
  );
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
}: {
  layer: UdmTextLayer;
  layerIdx: number;
  pageIdx: number;
  resources: Document["resources"];
  scale: number;
  editing: EditingState | null;
  editedKeys: ReadonlySet<string>;
  onStartEdit: (s: EditingState) => void;
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
}: {
  run: PositionedTextRun;
  resources: Document["resources"];
  scale: number;
  isEdited: boolean;
  onClick: () => void;
}) {
  const font = resources.fonts.find((f) => f.id === run.font_id);
  const x = lengthToPx(run.x) * scale;
  const y = lengthToPx(run.y) * scale;
  const fontSize = lengthToPx(run.font_size) * scale;
  const top = y - fontSize * BASELINE_TO_TOP;

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
      onClick={onClick}
      onTap={onClick}
      onMouseEnter={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "text")}
      onMouseLeave={(e: KonvaEventObject<MouseEvent>) => setCursor(e, "default")}
    />
  );
}

function ImageNode({
  layer,
  resources,
  scale,
}: {
  layer: UdmImageLayer;
  resources: Document["resources"];
  scale: number;
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

  return (
    <KonvaImage
      image={image}
      x={x}
      y={y}
      width={w}
      height={h}
      rotation={layer.rotation ?? 0}
      opacity={layer.opacity ?? 1}
      // Images must not intercept clicks in v1 — only text is interactive.
      // Without this, off-page or oversized images (lesson #3) block clicks
      // on text runs that visually sit on top of them. Konva hit-tests
      // top-down; a tight text bbox can let clicks fall through into the
      // image's much larger hit area.
      listening={false}
    />
  );
}

function ShapeNode({ layer, scale }: { layer: UdmShapeLayer; scale: number }) {
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
      listening={false}
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

function EditorHeader({
  scale,
  onScaleChange,
  placeMode,
  onTogglePlaceMode,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
  placeMode: boolean;
  onTogglePlaceMode: () => void;
}) {
  const presets = [0.5, 0.75, 1, 1.25, 1.5];
  return (
    <div className="flex items-center justify-between gap-3 border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-1">
        <span className="label mr-2">scale</span>
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => onScaleChange(p)}
            className={`font-mono text-xs px-2 py-1 border transition-colors ${
              scale === p
                ? "bg-accent text-accent-fg border-accent"
                : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
            }`}
          >
            {Math.round(p * 100)}%
          </button>
        ))}
        <button
          onClick={onTogglePlaceMode}
          className={`font-mono text-xs px-2 py-1 border transition-colors ml-3 ${
            placeMode
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
          }`}
        >
          ⊕ place image in region
        </button>
      </div>
      <div className="label text-muted">
        {placeMode
          ? "drag a box over the area to replace, then pick an image"
          : "click any text to edit · enter to commit · esc to cancel"}
      </div>
    </div>
  );
}
