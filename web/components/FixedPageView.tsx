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

interface FixedPageViewProps {
  page: Page;
  resources: Resources;
  /** Display scale multiplier. 1.0 = 96 DPI native. */
  scale?: number;
}

/**
 * Read-only renderer for a single UDM fixed-mode page.
 * Each layer is positioned absolutely in pixel coords derived from the
 * UDM Length values. Text runs render with their declared font/size/color.
 */
export function FixedPageView({ page, resources, scale = 1 }: FixedPageViewProps) {
  const w = lengthToPx(page.width) * scale;
  const h = lengthToPx(page.height) * scale;

  return (
    <div
      role="region"
      aria-label={`Page ${page.number}`}
      className="relative bg-white border border-border"
      style={{ width: `${w}px`, height: `${h}px` }}
    >
      {page.layers.map((layer, i) => (
        <LayerView key={i} layer={layer} resources={resources} scale={scale} />
      ))}
    </div>
  );
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

  return (
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

  // data_ref of "xref:N" is opaque (importer ran without asset extraction).
  // Anything else is treated as a URL — relative refs resolve against the
  // host page, absolute paths and http(s) work directly.
  const ref = img?.data_ref ?? "";
  const isOpaque = !ref || ref.startsWith("xref:");
  const src = isOpaque ? undefined : ref;

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

function ShapeLayerView({ scale: _scale }: { layer: ShapeLayer; scale: number }) {
  // v0.1 viewer: shapes acknowledged but not rendered. Phase 2 adds SVG rendering.
  return null;
}

function AnnotationLayerView({ layer: _layer }: { layer: AnnotationLayer }) {
  // v0.1 viewer: annotations acknowledged but not rendered. Phase 2 adds them.
  return null;
}

function cssFontFamily(font: FontResource): string {
  // Resolution order:
  //   1. udm-<font_id>: matches the @font-face injected by FontFaceStyles
  //      when the font has a data_ref (extracted from the source document).
  //   2. The original family name (system or web font with that name).
  //   3. Generic sans-serif fallback.
  const family = font.family.includes(" ") ? `"${font.family}"` : font.family;
  return `"udm-${font.id}", ${family}, ui-sans-serif, system-ui, sans-serif`;
}
