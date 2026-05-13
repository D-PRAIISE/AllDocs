//! Fixed-mode content: PDF, scanned images, fixed-layout EPUB.
//!
//! See UDM_SPEC.md §7.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::flow::FlowContent;
use crate::geometry::{Length, Matrix2D};
use crate::styles::ColorRef;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct FixedContent {
    pub pages: Vec<Page>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Page {
    pub number: u32,
    pub width: Length,
    pub height: Length,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<PageBackground>,
    pub layers: Vec<Layer>,
    /// Optional reflow-friendly projection of this page's content. Importers
    /// that can produce one (e.g. when a PDF has a tagged structure tree)
    /// store it here so the editor can offer a "edit text" UX without losing
    /// the underlying fixed layout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_projection: Option<FlowContent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PageBackground {
    Color(ColorRef),
    Image { image_id: String },
}

/// Layer in a Page. Tagged by `type`; rendered back-to-front in array order.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Layer {
    Text(TextLayer),
    Image(ImageLayer),
    Shape(ShapeLayer),
    Annotation(AnnotationLayer),
    Form(FormLayer),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TextLayer {
    pub runs: Vec<PositionedTextRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PositionedTextRun {
    pub text: String,
    pub font_id: String,
    pub font_size: Length,
    pub color: ColorRef,
    /// Baseline origin x.
    pub x: Length,
    /// Baseline origin y.
    pub y: Length,
    /// Optional explicit per-glyph advances (kerning, complex scripts).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advances: Vec<f64>,
    /// Rotation in degrees about (x, y).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    /// If present, takes precedence over x/y/rotation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Matrix2D>,
    /// Marker that this run came from OCR, not from encoded text in the source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr: Option<OcrInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OcrInfo {
    pub confidence: f64,
    pub engine: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImageLayer {
    pub image_id: String,
    pub x: Length,
    pub y: Length,
    pub width: Length,
    pub height: Length,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ShapeLayer {
    pub geometry: Geometry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Matrix2D>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Geometry {
    Path {
        d: String,
    },
    #[serde(rename = "rect")]
    Rectangle {
        x: Length,
        y: Length,
        w: Length,
        h: Length,
    },
    Ellipse {
        cx: Length,
        cy: Length,
        rx: Length,
        ry: Length,
    },
    Polygon {
        points: Vec<(Length, Length)>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Paint {
    Solid {
        color: ColorRef,
    },
    LinearGradient {
        stops: Vec<GradientStop>,
        angle: f64,
    },
    RadialGradient {
        stops: Vec<GradientStop>,
    },
    Pattern {
        image_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GradientStop {
    pub offset: f64,
    pub color: ColorRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Stroke {
    pub paint: Paint,
    pub width: Length,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cap: Option<LineCap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join: Option<LineJoin>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dash: Vec<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LineCap {
    Butt,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LineJoin {
    Miter,
    Round,
    Bevel,
}

/// Annotation kinds: highlight, comment, stamp, ink, link, redaction.
/// kind-specific payloads are stubbed for v0.1; v0.2 will define typed variants.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AnnotationLayer {
    pub kind: AnnotationKind,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Highlight,
    Comment,
    Stamp,
    Ink,
    Link,
    Redaction,
}

/// AcroForm or XFA fields. Per-field shape stubbed for v0.1, see UDM_SPEC.md §14.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FormLayer {
    pub fields: Vec<serde_json::Value>,
}
