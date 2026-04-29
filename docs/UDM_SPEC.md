# Universal Document Model (UDM) — Specification

> **Version:** 0.1.0 (Draft)
> **Status:** Active — this is the architectural cornerstone of AllDocs.
> Every importer and exporter targets UDM. Changes here ripple through every adapter.
> Breaking changes require a major version bump and a migration tool.

---

## 1. Motivation

A document conversion system has two design choices:

1. Write **N×M format converters** — every format directly to every other format.
2. Define one **canonical Intermediate Representation (IR)** and write N importers + M exporters.

AllDocs commits to the second path. The IR is the **Universal Document Model (UDM)**.

UDM is **not** "HTML with extra fields." HTML cannot losslessly represent a fixed-layout PDF, a spreadsheet with formulas, or a slide deck with animations and master layouts. UDM is a multi-mode model that picks the right shape for the document at hand — and supports hybrid documents that need more than one shape.

## 2. Design Principles

1. **Lossless round-trip is the goal.** `import(file) → export(udm)` should produce a byte-identical or visually-identical result. Anything we can't yet model is preserved in opaque `extensions` blobs that survive round-trip even when the editor can't render them.
2. **Editable in the browser.** UDM is the contract between adapters and the editor. The editor manipulates UDM directly; it never sees the source format.
3. **Streamable.** Documents can be huge (10,000-page PDFs, million-cell spreadsheets). Pages, sheets, and slides may be loaded lazily via resource references rather than inlined.
4. **Versioned (semver).** Every UDM document declares the spec version it conforms to. Adapters declare the version range they emit. Older versions migrate forward via a migration tool.
5. **Format-agnostic typography.** Fonts, colors, and measurements use one unified system rather than format-specific quirks.
6. **Opaque preservation.** What we can't model is preserved verbatim in `extensions`. Importers should never silently drop information.

## 3. Top-Level Schema

```typescript
interface Document {
  // Spec version (semver) this document conforms to.
  udm_version: string;            // e.g. "0.1.0"

  // Stable document identifier (UUIDv4).
  id: string;

  // Primary content mode.
  mode: "flow" | "fixed" | "sheet" | "slides" | "hybrid";

  // Document-level metadata.
  metadata: Metadata;

  // Shared resources referenced by content (fonts, images, styles, colors).
  resources: Resources;

  // Content tree. Shape depends on `mode`.
  content: FlowContent | FixedContent | SheetContent | SlidesContent | HybridContent;

  // Adapter-specific opaque data preserved verbatim through round-trip.
  // Keys are namespaced: "<adapter>.<key>", e.g. "pdf.original_xref_table".
  extensions?: Record<string, unknown>;
}
```

## 4. Metadata

```typescript
interface Metadata {
  title?: string;
  authors?: string[];
  subject?: string;
  keywords?: string[];
  language?: string;              // BCP-47 tag, e.g. "en-US", "zh-Hans", "ar-EG"
  created_at?: string;            // ISO 8601
  modified_at?: string;
  source_format: SourceFormat;    // what was imported
  source_hash: string;            // SHA-256 of source bytes (hex)
  custom_properties?: Record<string, string | number | boolean>;
}

interface SourceFormat {
  mime: string;                   // e.g. "application/pdf"
  extension: string;              // e.g. "pdf"
  variant?: string;               // e.g. "PDF/A-1b", "DOCX (OOXML 2007)"
  producer?: string;              // tool that created the source, if known
}
```

## 5. Resources

Resources are content referenced by id from the content tree. This deduplicates fonts/images and keeps the content tree compact.

```typescript
interface Resources {
  fonts: FontResource[];
  images: ImageResource[];
  styles: StyleResource[];
  colors: ColorResource[];
  embedded_objects?: EmbeddedObject[]; // OLE objects, charts, etc.
}

interface FontResource {
  id: string;
  family: string;                 // e.g. "Helvetica Neue"
  weight: number;                 // 100–900
  style: "normal" | "italic" | "oblique";
  source: "embedded" | "system" | "google" | "substituted";
  data_ref?: string;              // pointer to font bytes if embedded
  license?: string;               // SPDX id or "proprietary"
  fallback_chain?: string[];      // ordered font ids to try if this fails to load
  substituted_for?: string;       // if source = "substituted", original family name
}

interface ImageResource {
  id: string;
  format: "png" | "jpeg" | "webp" | "tiff" | "svg" | "heic" | "raw";
  width: number;                  // pixels
  height: number;                 // pixels
  dpi?: number;
  data_ref: string;               // pointer to bytes in object store
  alt_text?: string;
  color_profile?: string;         // ColorResource id
}

interface StyleResource {
  id: string;
  name: string;                   // e.g. "Heading 1", "Body Text"
  inherits?: string;              // parent style id
  properties: StyleProperties;
}

interface StyleProperties {
  font_id?: string;
  font_size?: Length;
  color?: ColorRef;
  background?: ColorRef;
  alignment?: "left" | "right" | "center" | "justify" | "start" | "end";
  line_height?: number | Length;
  letter_spacing?: Length;
  margin?: Edges<Length>;
  padding?: Edges<Length>;
  border?: BorderSet;
  // Extends as needed; additions are minor version bumps.
}

interface ColorResource {
  id: string;
  name?: string;                  // e.g. "Brand Primary"
  value: ColorValue;
  profile?: string;               // ICC profile name or "sRGB"
}

type ColorValue =
  | { kind: "rgb"; r: number; g: number; b: number; a?: number }
  | { kind: "cmyk"; c: number; m: number; y: number; k: number }
  | { kind: "hex"; hex: string }
  | { kind: "named"; name: string };

interface ColorRef {
  ref?: string;                   // ColorResource id
  literal?: ColorValue;           // inline value
}
```

### 5.1 Length

All measurements use `Length`:

```typescript
type Length =
  | { value: number; unit: "px" | "pt" | "pc" | "in" | "cm" | "mm" | "em" | "%" };
```

Importers should preserve the source unit when possible. The editor and exporter convert as needed.

### 5.2 Edges and Borders

```typescript
interface Edges<T> {
  top?: T;
  right?: T;
  bottom?: T;
  left?: T;
}

interface BorderSet {
  top?: Border;
  right?: Border;
  bottom?: Border;
  left?: Border;
}

interface Border {
  width: Length;
  style: "solid" | "dashed" | "dotted" | "double" | "none";
  color: ColorRef;
}
```

## 6. Content — Flow Mode

For DOCX, ODT, MD, HTML, EPUB (reflowable), RTF, plain text.

```typescript
interface FlowContent {
  blocks: Block[];
}

type Block =
  | Paragraph
  | Heading
  | List
  | Table
  | CodeBlock
  | Quote
  | Divider
  | ImageBlock
  | Embed;

interface Paragraph {
  type: "paragraph";
  style_id?: string;
  inlines: Inline[];
}

interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  style_id?: string;
  inlines: Inline[];
}

interface List {
  type: "list";
  ordered: boolean;
  style_id?: string;
  start?: number;                 // for ordered lists, starting number
  items: ListItem[];
}

interface ListItem {
  blocks: Block[];                // recursive — supports nested lists, multi-paragraph items
}

interface Table {
  type: "table";
  rows: TableRow[];
  column_widths?: Length[];
  style_id?: string;
  caption?: Inline[];
}

interface TableRow {
  cells: TableCell[];
  is_header?: boolean;
}

interface TableCell {
  blocks: Block[];
  colspan?: number;
  rowspan?: number;
  style_id?: string;
}

interface CodeBlock {
  type: "code";
  language?: string;
  content: string;
}

interface Quote {
  type: "quote";
  blocks: Block[];
  citation?: Inline[];
}

interface Divider {
  type: "divider";
}

interface ImageBlock {
  type: "image";
  image_id: string;
  caption?: Inline[];
  width?: Length;
  height?: Length;
  alignment?: "left" | "center" | "right" | "inline";
}

interface Embed {
  type: "embed";
  // For things like math equations as block, embedded charts, OLE objects.
  kind: "math" | "chart" | "ole" | "iframe";
  // kind-specific payload
  data: unknown;
}
```

### 6.1 Inlines

```typescript
type Inline =
  | TextRun
  | LineBreak
  | InlineImage
  | Hyperlink
  | InlineMath
  | Footnote
  | Citation
  | InlineEmbed;

interface TextRun {
  type: "text";
  text: string;
  style_id?: string;
  marks?: Mark[];                 // inline overrides on top of style
}

type Mark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strikethrough" }
  | { type: "superscript" }
  | { type: "subscript" }
  | { type: "code" }
  | { type: "color"; color: ColorRef }
  | { type: "highlight"; color: ColorRef }
  | { type: "font"; font_id: string }
  | { type: "size"; size: Length };

interface LineBreak {
  type: "br";
  hard?: boolean;                 // \\\\ in MD vs soft wrap
}

interface InlineImage {
  type: "image_inline";
  image_id: string;
  width?: Length;
  height?: Length;
}

interface Hyperlink {
  type: "link";
  href: string;
  title?: string;
  inlines: Inline[];
}

interface InlineMath {
  type: "math";
  source: { mathml?: string; latex?: string };
}

interface Footnote {
  type: "footnote";
  id: string;
  blocks: Block[];                // footnote body
}

interface Citation {
  type: "citation";
  key: string;                    // bibliography key
  display: Inline[];              // rendered citation text
}
```

## 7. Content — Fixed Mode

For PDF, scanned images, fixed-layout EPUB.

```typescript
interface FixedContent {
  pages: Page[];
}

interface Page {
  number: number;                 // 1-indexed
  width: Length;
  height: Length;
  background?: ColorRef | { image_id: string };
  layers: Layer[];                // rendered back-to-front

  // OPTIONAL flow projection.
  // If the importer can produce a reflow-friendly text rendering of the page,
  // store it here. Used by the editor to enable "edit text" UX without losing
  // the original fixed layout.
  flow_projection?: FlowContent;
}

type Layer = TextLayer | ImageLayer | ShapeLayer | AnnotationLayer | FormLayer;

interface TextLayer {
  type: "text";
  runs: PositionedTextRun[];
}

interface PositionedTextRun {
  text: string;
  font_id: string;
  font_size: Length;
  color: ColorRef;
  // Position of the baseline origin, in page coordinates.
  x: Length;
  y: Length;
  // Optional explicit per-glyph advances (kerning, complex scripts).
  advances?: number[];
  rotation?: number;              // degrees, around (x, y)
  transform?: Matrix2D;           // overrides x/y/rotation if present
  // Marker that this run was generated by OCR rather than encoded in the source.
  ocr?: { confidence: number; engine: string };
}

interface ImageLayer {
  type: "image";
  image_id: string;
  x: Length;
  y: Length;
  width: Length;
  height: Length;
  rotation?: number;
  opacity?: number;               // 0–1
}

interface ShapeLayer {
  type: "shape";
  geometry: Path | Rectangle | Ellipse | Polygon;
  fill?: Paint;
  stroke?: Stroke;
  transform?: Matrix2D;
  opacity?: number;
}

interface AnnotationLayer {
  type: "annotation";
  kind: "highlight" | "comment" | "stamp" | "ink" | "link" | "redaction";
  // kind-specific payload (TBD per-kind in v0.2)
  data: unknown;
}

interface FormLayer {
  type: "form";
  fields: FormField[];            // AcroForm or XFA fields (TBD v0.2)
}

interface Matrix2D {
  a: number; b: number;
  c: number; d: number;
  e: number; f: number;
}

interface Path { kind: "path"; d: string; }            // SVG path data
interface Rectangle { kind: "rect"; x: Length; y: Length; w: Length; h: Length; }
interface Ellipse { kind: "ellipse"; cx: Length; cy: Length; rx: Length; ry: Length; }
interface Polygon { kind: "polygon"; points: [Length, Length][]; }

type Paint =
  | { kind: "solid"; color: ColorRef }
  | { kind: "linear_gradient"; stops: GradientStop[]; angle: number }
  | { kind: "radial_gradient"; stops: GradientStop[] }
  | { kind: "pattern"; image_id: string };

interface GradientStop { offset: number; color: ColorRef; }

interface Stroke {
  paint: Paint;
  width: Length;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  dash?: number[];
}
```

## 8. Content — Sheet Mode

For XLSX, ODS, CSV, Numbers.

```typescript
interface SheetContent {
  sheets: Sheet[];
  named_ranges?: NamedRange[];
  defined_names?: DefinedName[];
}

interface Sheet {
  name: string;
  // Sparse cell map — only populated cells are stored.
  cells: Record<CellAddress, Cell>;
  row_heights?: Record<number, Length>;
  column_widths?: Record<string, Length>;
  merges?: CellRange[];
  charts?: Chart[];
  pivot_tables?: PivotTable[];
  conditional_formats?: ConditionalFormat[];
  protection?: SheetProtection;
  hidden?: boolean;
}

type CellAddress = string;        // A1 notation, e.g. "A1", "AB17"

interface Cell {
  value: CellValue;
  formula?: string;               // original formula text, e.g. "=SUM(A1:A10)"
  display?: string;               // formatted display string from the source (cache)
  format?: NumberFormat;          // format code, e.g. "#,##0.00", "yyyy-mm-dd"
  style_id?: string;
  comment?: { author: string; text: string };
  hyperlink?: string;
  data_validation?: DataValidation;
}

type CellValue =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "date"; value: string /* ISO 8601 */ }
  | { kind: "error"; code: string }
  | { kind: "empty" };

interface CellRange { start: CellAddress; end: CellAddress; }
interface NamedRange { name: string; range: CellRange; sheet_name?: string; }
interface DefinedName { name: string; expression: string; scope?: string; }

// Charts, PivotTable, ConditionalFormat, NumberFormat, DataValidation, SheetProtection
// are detailed in v0.2.
```

## 9. Content — Slides Mode

For PPTX, ODP, Keynote.

```typescript
interface SlidesContent {
  slides: Slide[];
  masters: SlideMaster[];
  layouts: SlideLayout[];
  theme: SlideTheme;
}

interface Slide {
  id: string;
  layout_id: string;
  number: number;
  width: Length;
  height: Length;
  background?: ColorRef | { image_id: string };
  // Slides reuse fixed-mode shapes for positioning.
  shapes: SlideShape[];
  notes?: FlowContent;
  transitions?: Transition;
  animations?: Animation[];
  hidden?: boolean;
}

interface SlideShape {
  // Same shape as fixed-mode layers, plus placeholder semantics.
  layer: Layer;
  placeholder?: PlaceholderKind;  // "title" | "body" | "image" | etc.
  name?: string;
}

// SlideMaster, SlideLayout, SlideTheme, Transition, Animation: detailed in v0.2.
```

## 10. Hybrid Mode

For documents inherently mixed (modern PDF with reflow projections per page, EPUB3 with fixed-layout sections, etc.).

```typescript
interface HybridContent {
  primary: "flow" | "fixed" | "sheet" | "slides";
  layers: {
    flow?: FlowContent;
    fixed?: FixedContent;
    sheet?: SheetContent;
    slides?: SlidesContent;
  };
}
```

## 11. Versioning

UDM follows [SemVer 2.0.0](https://semver.org).

| Bump | Trigger | Examples |
|------|---------|----------|
| **Patch** (`0.1.0` → `0.1.1`) | Spec text clarifications, doc fixes | Reword ambiguous field |
| **Minor** (`0.1.x` → `0.2.0`) | New optional fields | Add `revision_marks` field, define `Chart` shape |
| **Major** (`0.x` → `1.0`) | Breaking changes | Rename a required field, change type semantics |

Adapters MUST declare the UDM version range they support. The editor accepts any version `>= editor_baseline`. A migration tool ships with each major version bump.

## 12. Validation

A document is valid if all of the following hold:

1. Conforms to the JSON Schema (auto-generated from this spec, lives in `proto/udm.schema.json`).
2. Conforms to the Rust types in `core/udm/src/types.rs` (the source of truth — JSON Schema is generated from these).
3. Every `*_id` reference resolves to an existing resource.
4. The mode-specific content tree is well-formed.
5. **Round-trip invariant** (for adapters): `import(file) → udm1; export(udm1) → file2; import(file2) → udm2`. `udm1` and `udm2` MUST be structurally equivalent (modulo `id` regeneration).

## 13. Reserved Field Names

Reserved on every UDM object for future use, do not use as adapter keys:

- `id`
- `extensions`
- `_meta`
- `udm_version`

## 14. Open Questions (target: v0.2)

The following are deliberately under-specified in v0.1 and will be closed out in v0.2:

- **Track changes / revisions** — separate top-level `revisions` field, or marks embedded in inlines?
- **Comments / annotations across modes** — unified `comments` resource?
- **Digital signatures** — preservation strategy and verification UX
- **Forms** — unify AcroForm + XFA + DOCX form fields, or keep mode-specific?
- **Embedded media** (video, audio) — new `MediaResource` type?
- **Right-to-left and bidirectional text** — explicit `direction` field, or rely on Unicode + `metadata.language`?
- **Color management** — full ICC profile support or sRGB-only for v1?
- **Math** — MathML as canonical or LaTeX? (current v0.1 stores both — pick a primary)
- **Charts** — full structural model (data + type + encoding) or render-as-image-and-preserve-source?
- **Animations** — full timeline model for slides, or descriptive metadata only?

## 15. Non-Goals

- **Real-time collaboration** is out of scope for UDM. CRDT/OT layers live above UDM in the editor, not in the document model.
- **Rendering pixel parity** is not guaranteed across exporters. Visual fidelity is a quality goal, not a UDM contract.
- **Format-specific quirks** that have no semantic meaning (e.g. PDF's exact xref structure) are stored in `extensions`, not modeled.

---

## Changelog

- **0.1.0** (2026-04-26) — Initial draft. Top-level shape, four content modes, hybrid, resources, validation contract, open questions enumerated.
