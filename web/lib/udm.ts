// TypeScript types for UDM v0.1.0.
//
// Source of truth: core/udm/src/*.rs. The proto/udm.schema.json is
// auto-generated from the Rust types via `cargo run --bin gen_schema`.
// These TS types are hand-written and must match the schema; a future
// step will auto-generate them via json-schema-to-typescript.
//
// See docs/UDM_SPEC.md for the human-readable description.

export const UDM_VERSION = "0.1.0";

// ----- Document -----

export interface Document {
  udm_version: string;
  id: string;
  mode: Mode;
  metadata: Metadata;
  resources: Resources;
  content: FlowContent | FixedContent | SheetContent | SlidesContent | HybridContent;
  extensions?: Record<string, unknown>;
}

export type Mode = "flow" | "fixed" | "sheet" | "slides" | "hybrid";

export interface Metadata {
  title?: string;
  authors?: string[];
  subject?: string;
  keywords?: string[];
  language?: string;
  created_at?: string;
  modified_at?: string;
  source_format: SourceFormat;
  source_hash: string;
  custom_properties?: Record<string, string | number | boolean>;
}

export interface SourceFormat {
  mime: string;
  extension: string;
  variant?: string;
  producer?: string;
}

// ----- Resources -----

export interface Resources {
  fonts: FontResource[];
  images: ImageResource[];
  styles: StyleResource[];
  colors: ColorResource[];
  embedded_objects?: unknown[];
}

export interface FontResource {
  id: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  source: "embedded" | "system" | "google" | "substituted";
  data_ref?: string;
  license?: string;
  fallback_chain?: string[];
  substituted_for?: string;
  _meta?: Record<string, unknown>;
}

export interface ImageResource {
  id: string;
  format: "png" | "jpeg" | "webp" | "tiff" | "svg" | "heic" | "raw";
  width: number;
  height: number;
  dpi?: number;
  data_ref: string;
  alt_text?: string;
  color_profile?: string;
}

export interface StyleResource {
  id: string;
  name: string;
  inherits?: string;
  properties: StyleProperties;
}

export interface ColorResource {
  id: string;
  name?: string;
  value: ColorValue;
  profile?: string;
}

// ----- Geometry & Styles -----

export type Unit = "px" | "pt" | "pc" | "in" | "cm" | "mm" | "em" | "%";

export interface Length {
  value: number;
  unit: Unit;
}

export type ColorValue =
  | { kind: "rgb"; r: number; g: number; b: number; a?: number }
  | { kind: "cmyk"; c: number; m: number; y: number; k: number }
  | { kind: "hex"; hex: string }
  | { kind: "named"; name: string };

export interface ColorRef {
  ref?: string;
  literal?: ColorValue;
}

export interface StyleProperties {
  font_id?: string;
  font_size?: Length;
  color?: ColorRef;
  background?: ColorRef;
  alignment?: "left" | "right" | "center" | "justify" | "start" | "end";
  // ... extends as needed
}

// ----- Content: Fixed mode -----

export interface FixedContent {
  pages: Page[];
}

export interface Page {
  number: number;
  width: Length;
  height: Length;
  background?: ColorRef | { image_id: string };
  layers: Layer[];
  flow_projection?: FlowContent;
}

export type Layer = TextLayer | ImageLayer | ShapeLayer | AnnotationLayer | FormLayer;

export interface TextLayer {
  type: "text";
  runs: PositionedTextRun[];
}

export interface PositionedTextRun {
  text: string;
  font_id: string;
  font_size: Length;
  color: ColorRef;
  x: Length;
  y: Length;
  advances?: number[];
  rotation?: number;
  ocr?: { confidence: number; engine: string };
}

export interface ImageLayer {
  type: "image";
  image_id: string;
  x: Length;
  y: Length;
  width: Length;
  height: Length;
  rotation?: number;
  opacity?: number;
}

export interface ShapeLayer {
  type: "shape";
  geometry: unknown;
  fill?: unknown;
  stroke?: unknown;
  opacity?: number;
}

export interface AnnotationLayer {
  type: "annotation";
  kind: "highlight" | "comment" | "stamp" | "ink" | "link" | "redaction";
  data: unknown;
}

export interface FormLayer {
  type: "form";
  fields: unknown[];
}

// ----- Other modes (stubbed for v0.1 viewer) -----

export interface FlowContent {
  blocks: unknown[];
}
export interface SheetContent {
  sheets: unknown[];
}
export interface SlidesContent {
  slides: unknown[];
}
export interface HybridContent {
  primary: Mode;
  layers: { flow?: FlowContent; fixed?: FixedContent; sheet?: SheetContent; slides?: SlidesContent };
}

// ----- Helpers -----

const PT_TO_PX = 4 / 3; // 1 pt = 1/72 in; 1 in = 96 px → 1 pt = 96/72 = 4/3 px

/** Convert a Length to CSS pixels at 96 DPI. */
export function lengthToPx(len: Length): number {
  switch (len.unit) {
    case "px":
      return len.value;
    case "pt":
      return len.value * PT_TO_PX;
    case "in":
      return len.value * 96;
    case "cm":
      return (len.value / 2.54) * 96;
    case "mm":
      return (len.value / 25.4) * 96;
    case "pc":
      return len.value * 16; // 1 pc = 12 pt = 16 px
    case "em":
      return len.value * 16; // approx — depends on context
    case "%":
      return len.value; // caller resolves
    default:
      return len.value;
  }
}

/** Resolve a ColorRef to a CSS color string. */
export function colorRefToCss(ref: ColorRef, resources?: Resources): string {
  if (ref.literal) {
    return colorValueToCss(ref.literal);
  }
  if (ref.ref && resources) {
    const found = resources.colors.find((c) => c.id === ref.ref);
    if (found) return colorValueToCss(found.value);
  }
  return "currentColor";
}

function colorValueToCss(v: ColorValue): string {
  switch (v.kind) {
    case "rgb":
      return v.a !== undefined
        ? `rgba(${v.r},${v.g},${v.b},${v.a / 255})`
        : `rgb(${v.r},${v.g},${v.b})`;
    case "hex":
      return v.hex;
    case "named":
      return v.name;
    case "cmyk":
      // Crude CMYK→RGB; production would do proper conversion via ICC profile.
      return `rgb(${(1 - v.c) * (1 - v.k) * 255},${(1 - v.m) * (1 - v.k) * 255},${(1 - v.y) * (1 - v.k) * 255})`;
  }
}
