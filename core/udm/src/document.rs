//! Top-level Document, Mode, Metadata, SourceFormat.
//!
//! See UDM_SPEC.md §3, §4.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    fixed::FixedContent, flow::FlowContent, hybrid::HybridContent, resources::Resources,
    sheet::SheetContent, slides::SlidesContent,
};

/// Top-level UDM document. The shape of `content` is determined by `mode`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Document {
    /// SemVer of the UDM spec this document conforms to.
    pub udm_version: String,
    /// Stable document identifier (UUIDv4 expected).
    pub id: String,
    /// Primary content mode.
    pub mode: Mode,
    pub metadata: Metadata,
    #[serde(default)]
    pub resources: Resources,
    pub content: Content,
    /// Adapter-specific opaque data preserved verbatim through round-trip.
    /// Keys must be namespaced as `<adapter>.<key>` (UDM_SPEC.md §3).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extensions: HashMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Flow,
    Fixed,
    Sheet,
    Slides,
    Hybrid,
}

/// Discriminated union of content trees. Disambiguated by which top-level
/// field is present (each content type has unique fields: `blocks`, `pages`,
/// `sheets`, `slides`, `primary`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Content {
    Flow(FlowContent),
    Fixed(FixedContent),
    Sheet(SheetContent),
    Slides(SlidesContent),
    Hybrid(HybridContent),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// BCP-47 language tag, e.g. "en-US", "zh-Hans".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub source_format: SourceFormat,
    /// SHA-256 hex of the source bytes.
    pub source_hash: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub custom_properties: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceFormat {
    pub mime: String,
    pub extension: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
}
