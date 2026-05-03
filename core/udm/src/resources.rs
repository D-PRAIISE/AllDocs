//! Shared resources (fonts, images, styles, colors) referenced by content.
//!
//! See UDM_SPEC.md §5.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::styles::{ColorValue, StyleProperties};

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Resources {
    #[serde(default)]
    pub fonts: Vec<FontResource>,
    #[serde(default)]
    pub images: Vec<ImageResource>,
    #[serde(default)]
    pub styles: Vec<StyleResource>,
    #[serde(default)]
    pub colors: Vec<ColorResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embedded_objects: Vec<EmbeddedObject>,
}

/// A font face usable by text content. The `source` field tells the editor
/// whether glyph fallback may be needed:
/// - `Embedded` → may be a subset; check `has_glyph` before insertion
/// - `System`   → assumed full font, but availability not guaranteed at render time
/// - `Google`   → fetch from Google Fonts CDN
/// - `Substituted` → original font wasn't available; `substituted_for` names the original
///
/// (See `project_alldocs_pdf_adapter.md` lesson #1.)
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FontResource {
    pub id: String,
    pub family: String,
    pub weight: u16,
    pub style: FontStyle,
    pub source: FontSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback_chain: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub substituted_for: Option<String>,
    /// Adapter-specific opaque metadata (e.g. PDF subset prefix). Reserved per spec §13.
    #[serde(default, rename = "_meta", skip_serializing_if = "HashMap::is_empty")]
    pub meta: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FontSource {
    Embedded,
    System,
    Google,
    Substituted,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImageResource {
    pub id: String,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dpi: Option<u32>,
    pub data_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_profile: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
    Tiff,
    Svg,
    Heic,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StyleResource {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inherits: Option<String>,
    pub properties: StyleProperties,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ColorResource {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub value: ColorValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// Opaque container for embedded OLE objects, charts, and other format-specific
/// payloads we don't yet model structurally. v0.2 will define typed variants.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EmbeddedObject {
    pub id: String,
    pub kind: String,
    pub data_ref: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub properties: HashMap<String, Value>,
}
