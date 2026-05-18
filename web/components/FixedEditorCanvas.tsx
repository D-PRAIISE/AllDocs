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
  type Page,
  type PositionedTextRun,
  type ShapeLayer as UdmShapeLayer,
  type TextLayer as UdmTextLayer,
  colorRefToCss,
  lengthToPx,
} from "@/lib/udm";

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

export default function FixedEditorCanvas({ doc, onChange }: FixedEditorCanvasProps) {
  const fixed = doc.content as FixedContent;
  const [scale, setScale] = useState(1);
  const [editing, setEditing] = useState<EditingState | null>(null);

  const updateRun = useCallback(
    (pageIdx: number, layerIdx: number, runIdx: number, nextText: string) => {
      const next = structuredClone(doc) as Document;
      const content = next.content as FixedContent;
      const layer = content.pages[pageIdx]!.layers[layerIdx]!;
      if (layer.type !== "text") return;
      const run = layer.runs[runIdx]!;
      run.text = nextText;
      onChange(next);
    },
    [doc, onChange]
  );

  return (
    <div className="space-y-4">
      <EditorHeader scale={scale} onScaleChange={setScale} />
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
              onStartEdit={setEditing}
              onCancelEdit={() => setEditing(null)}
              onCommitEdit={(state, text) => {
                updateRun(state.pageIdx, state.layerIdx, state.runIdx, text);
                setEditing(null);
              }}
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

function FixedPageEditor({
  page,
  pageIdx,
  doc,
  scale,
  editing,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
}: {
  page: Page;
  pageIdx: number;
  doc: Document;
  scale: number;
  editing: EditingState | null;
  onStartEdit: (s: EditingState) => void;
  onCancelEdit: () => void;
  onCommitEdit: (s: EditingState, text: string) => void;
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
    </div>
  );
}

function TextNodes({
  layer,
  layerIdx,
  pageIdx,
  resources,
  scale,
  editing,
  onStartEdit,
}: {
  layer: UdmTextLayer;
  layerIdx: number;
  pageIdx: number;
  resources: Document["resources"];
  scale: number;
  editing: EditingState | null;
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
            onClick={() => onStartEdit({ pageIdx, layerIdx, runIdx, initialText: run.text })}
          />
        );
      })}
    </>
  );
}

function TextRunNode({
  run,
  resources,
  scale,
  onClick,
}: {
  run: PositionedTextRun;
  resources: Document["resources"];
  scale: number;
  onClick: () => void;
}) {
  const font = resources.fonts.find((f) => f.id === run.font_id);
  const x = lengthToPx(run.x) * scale;
  const y = lengthToPx(run.y) * scale;
  const fontSize = lengthToPx(run.font_size) * scale;
  const top = y - fontSize * BASELINE_TO_TOP;
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
      onMouseEnter={(e: KonvaEventObject<MouseEvent>) => {
        const stage = e.target.getStage();
        if (stage) stage.container().style.cursor = "text";
      }}
      onMouseLeave={(e: KonvaEventObject<MouseEvent>) => {
        const stage = e.target.getStage();
        if (stage) stage.container().style.cursor = "default";
      }}
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
  onCommit: (s: EditingState, text: string) => void;
  onCancel: () => void;
}) {
  const layer = page.layers[state.layerIdx];
  const run = layer && layer.type === "text" ? layer.runs[state.runIdx] : null;
  const spanRef = useRef<HTMLSpanElement | null>(null);
  // Track the latest text on a ref so onBlur/onKeyDown can read it without
  // re-rendering the contentEditable (which would clobber the caret).
  const valueRef = useRef(state.initialText);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    el.textContent = state.initialText;
    valueRef.current = state.initialText;
    // Focus + select-all so the user can immediately type to replace.
    queueMicrotask(() => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  }, [state.initialText, state.pageIdx, state.layerIdx, state.runIdx]);

  const style = useMemo(() => {
    if (!run) return null;
    const font = doc.resources.fonts.find((f) => f.id === run.font_id);
    const x = lengthToPx(run.x) * scale;
    const y = lengthToPx(run.y) * scale;
    const fontSize = lengthToPx(run.font_size) * scale;
    const top = y - fontSize * BASELINE_TO_TOP;
    return {
      position: "absolute" as const,
      left: x,
      top,
      fontSize,
      lineHeight: 1,
      fontFamily: konvaFontFamily(font),
      fontWeight: font?.weight ?? 400,
      fontStyle: font?.style ?? "normal",
      color: colorRefToCss(run.color, doc.resources),
      // Transparent so adjacent runs on the same visual line remain readable
      // while the user edits. The outline alone marks the editing zone.
      background: "transparent",
      outline: "1px solid var(--color-accent, #fcc46a)",
      outlineOffset: "1px",
      padding: 0,
      margin: 0,
      border: 0,
      whiteSpace: "pre" as const,
      display: "inline-block",
      caretColor: "var(--color-accent, #fcc46a)",
    } satisfies CSSProperties;
  }, [run, doc.resources, scale]);

  if (!run || !style) return null;

  return (
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
          onCommit(state, valueRef.current);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(state, valueRef.current)}
      style={style}
    />
  );
}

function EditorHeader({ scale, onScaleChange }: { scale: number; onScaleChange: (s: number) => void }) {
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
      </div>
      <div className="label text-muted">click any text to edit · enter to commit · esc to cancel</div>
    </div>
  );
}
