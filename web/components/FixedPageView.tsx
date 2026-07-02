import {
  type FontResource,
  type ImageResource,
  type Layer,
  type Page,
  type PositionedTextRun,
  type Resources,
  type ImageLayer,
  type AnnotationLayer,
  type ShapeLayer,
  colorRefToCss,
  lengthToPx,
} from "@/lib/udm";
import { type ReactNode } from "react";

import { type SearchMatch, matchKey } from "@/lib/text-search";
import { cssFontStack } from "@/lib/font-css";

interface FixedPageViewProps {
  page: Page;
  resources: Resources;
  /** Display scale multiplier. 1.0 = 96 DPI native. */
  scale?: number;
  /** Find-in-document matches that fall on this page (scaled px rects). */
  searchMatches?: SearchMatch[];
  /** Key of the currently-focused match, for stronger highlighting. */
  activeMatchKey?: string | null;
}

/**
 * Read-only renderer for a single UDM fixed-mode page.
 * Each layer is positioned absolutely in pixel coords derived from the
 * UDM Length values. Text runs render with their declared font/size/color.
 */
export function FixedPageView({
  page,
  resources,
  scale = 1,
  searchMatches,
  activeMatchKey,
}: FixedPageViewProps) {
  const w = lengthToPx(page.width) * scale;
  const h = lengthToPx(page.height) * scale;
  const pageWPt = page.width.unit === "pt" ? page.width.value : lengthToPx(page.width) / (96 / 72);
  const pageHPt = page.height.unit === "pt" ? page.height.value : lengthToPx(page.height) / (96 / 72);

  // Same paint-order classification used by the Konva editor + exporter:
  // page-spanning background shapes paint first, then images, then
  // decoration shapes, then text. DOM-stacks later siblings on top of
  // earlier ones, so the array order ends up being the visual order.
  const ordered = page.layers
    .map((layer, originalIdx) => ({ layer, originalIdx }))
    .sort(
      (a, b) =>
        paintOrderKey(a.layer, pageWPt, pageHPt) - paintOrderKey(b.layer, pageWPt, pageHPt)
    );

  return (
    <div
      role="region"
      aria-label={`Page ${page.number}`}
      className="relative bg-white border border-border overflow-hidden"
      style={{ width: `${w}px`, height: `${h}px` }}
    >
      {ordered.map(({ layer, originalIdx }) => (
        <LayerView key={originalIdx} layer={layer} resources={resources} scale={scale} />
      ))}
      {/* Find-in-document highlights — drawn on top of the page, never
          intercept clicks. Active match is stronger + outlined. */}
      {searchMatches?.map((m) => {
        const key = matchKey(m);
        const active = key === activeMatchKey;
        return (
          <div
            key={key}
            aria-hidden
            style={{
              position: "absolute",
              left: `${m.xPx}px`,
              top: `${m.yPx}px`,
              width: `${m.wPx}px`,
              height: `${m.hPx}px`,
              background: active ? "rgba(252,196,106,0.55)" : "rgba(252,196,106,0.32)",
              outline: active ? "1.5px solid #c67700" : "none",
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}

function paintOrderKey(layer: Layer, pageWPt: number, pageHPt: number): number {
  if (layer.type === "shape") {
    const geom = layer.geometry as { kind?: string; w?: { value: number }; h?: { value: number } };
    if (geom?.kind === "rect" && geom.w && geom.h) {
      const spansWidth = geom.w.value / pageWPt >= 0.9;
      const spansHeight = geom.h.value / pageHPt >= 0.9;
      const bigArea = (geom.w.value * geom.h.value) / (pageWPt * pageHPt) >= 0.2;
      if (spansWidth || spansHeight || bigArea) return 0; // bg shape
    }
    return 2; // fg shape
  }
  return { image: 1, annotation: 3, text: 4, form: 5 }[layer.type] ?? 99;
}

function LayerView({
  layer,
  resources,
  scale,
}: {
  layer: Layer;
  resources: Resources;
  scale: number;
}) {
  switch (layer.type) {
    case "text":
      return (
        <>
          {layer.runs.map((run, i) => (
            <TextRunView key={i} run={run} resources={resources} scale={scale} />
          ))}
        </>
      );
    case "image":
      return <ImageLayerView layer={layer} resources={resources} scale={scale} />;
    case "shape":
      return <ShapeLayerView layer={layer} scale={scale} />;
    case "annotation":
      return <AnnotationLayerView layer={layer} />;
    case "form":
      return null; // forms not rendered in v0.1 viewer
  }
}

function TextRunView({
  run,
  resources,
  scale,
}: {
  run: PositionedTextRun;
  resources: Resources;
  scale: number;
}) {
  // OCR runs sit on top of a scanned image that already shows the text, so
  // the viewer normally hides them (the scan is crisper). BUT an *edited*
  // OCR run must render — otherwise a saved edit would vanish under the
  // scan (users think their edit didn't save). Edited OCR runs draw a
  // background patch over the original scanned pixels, then the new text —
  // matching the editor and the PDF exporter.
  const editedOcr = !!(run.ocr && run._meta?.edited);
  if (run.ocr && !editedOcr) return null;

  const x = lengthToPx(run.x) * scale;
  const y = lengthToPx(run.y) * scale;
  const fontSize = lengthToPx(run.font_size) * scale;
  const color = colorRefToCss(run.color, resources);
  const font = resources.fonts.find((f) => f.id === run.font_id);
  const fontFamily = font ? cssFontFamily(font) : "inherit";
  const fontWeight = font?.weight ?? 400;
  const fontStyle = font?.style ?? "normal";

  // PositionedTextRun.y is the baseline; HTML positions by top edge.
  // Approximate baseline → top by subtracting ~0.8 * fontSize.
  const top = y - fontSize * 0.8;

  // Mask box covering the original scanned word (for edited OCR runs).
  let mask: ReactNode = null;
  if (editedOcr) {
    const bg = run._meta?.ocr_bg as number[] | undefined;
    const bgCss = bg && bg.length >= 3 ? `rgb(${bg[0]},${bg[1]},${bg[2]})` : "#ffffff";
    const wPt = run._meta?.ocr_width as number | undefined;
    const maskW =
      typeof wPt === "number"
        ? wPt * (96 / 72) * scale
        : Math.max(run.text.length, 1) * fontSize * 0.55;
    const pad = fontSize * 0.12;
    mask = (
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: `${x - pad}px`,
          top: `${top - fontSize * 0.1}px`,
          width: `${maskW + pad * 2}px`,
          height: `${fontSize * 1.25}px`,
          background: bgCss,
        }}
      />
    );
  }

  return (
    <>
      {mask}
      <span
        style={{
          position: "absolute",
          left: `${x}px`,
          top: `${top}px`,
          fontSize: `${fontSize}px`,
          fontFamily,
          fontWeight,
          fontStyle,
          color,
          whiteSpace: "pre",
          lineHeight: 1,
          transform: run.rotation ? `rotate(${run.rotation}deg)` : undefined,
          transformOrigin: "left baseline",
        }}
      >
        {run.text}
      </span>
    </>
  );
}

function ImageLayerView({
  layer,
  resources,
  scale,
}: {
  layer: ImageLayer;
  resources: Resources;
  scale: number;
}) {
  const img = resources.images.find((i: ImageResource) => i.id === layer.image_id);
  const x = lengthToPx(layer.x) * scale;
  const y = lengthToPx(layer.y) * scale;
  const w = lengthToPx(layer.width) * scale;
  const h = lengthToPx(layer.height) * scale;

  const ref = img?.data_ref ?? "";
  const isOpaque = !ref || ref.startsWith("xref:");
  const src = isOpaque ? undefined : ref;

  // PDF clip path: when set, the image is restricted to a sub-window.
  // Wrap in an overflow-hidden box at the clip rect, then position the
  // image inside so it lands at its full transform but only the
  // intersection shows.
  const clip = layer._meta?.clip;
  if (clip && src) {
    const ptToPx = (pt: number) => pt * (96 / 72) * scale;
    const cx = ptToPx(clip.x);
    const cy = ptToPx(clip.y);
    const cw = ptToPx(clip.w);
    const ch = ptToPx(clip.h);
    return (
      <div
        className="absolute overflow-hidden"
        style={{
          left: `${cx}px`,
          top: `${cy}px`,
          width: `${cw}px`,
          height: `${ch}px`,
          opacity: layer.opacity ?? 1,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={img?.alt_text ?? ""}
          style={{
            position: "absolute",
            left: `${x - cx}px`,
            top: `${y - cy}px`,
            width: `${w}px`,
            height: `${h}px`,
            objectFit: "fill",
            transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={
        src
          ? "absolute"
          : "absolute border border-dashed border-neutral-300 bg-neutral-100 text-xs text-neutral-400 flex items-center justify-center"
      }
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
        opacity: layer.opacity ?? 1,
        transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={img?.alt_text ?? ""}
          className="block w-full h-full"
          style={{ objectFit: "fill" }}
        />
      ) : (
        <span>image: {layer.image_id}</span>
      )}
    </div>
  );
}

function ShapeLayerView({ layer, scale }: { layer: ShapeLayer; scale: number }) {
  // Render solid-fill rectangles only (the importer also captures only rects
  // in v0.1). Curves, paths, and gradients land in v0.2.
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

  const bg = fill?.kind === "solid" && fill.color ? colorRefToCss(fill.color) : undefined;
  const border =
    stroke?.paint?.color && stroke.width
      ? `${lengthToPx(stroke.width) * scale}px solid ${colorRefToCss(stroke.paint.color)}`
      : undefined;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        background: bg,
        border,
        opacity: layer.opacity ?? 1,
        pointerEvents: "none",
      }}
    />
  );
}

function AnnotationLayerView({ layer: _layer }: { layer: AnnotationLayer }) {
  // v0.1 viewer: annotations acknowledged but not rendered. Phase 2 adds them.
  return null;
}

function cssFontFamily(font: FontResource): string {
  // Embedded subset → original family → metric-compatible clone →
  // class-correct generic. See lib/font-css.ts cssFontStack.
  return cssFontStack(font.family, font.id);
}
