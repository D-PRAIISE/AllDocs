//! Slides-mode content: PPTX, ODP, Keynote.
//!
//! See UDM_SPEC.md §9. Master/layouts/theme/animations are stubbed for v0.1.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fixed::Layer;
use crate::flow::FlowContent;
use crate::geometry::Length;
use crate::styles::ColorRef;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SlidesContent {
    pub slides: Vec<Slide>,
    #[serde(default)]
    pub masters: Vec<Value>,
    #[serde(default)]
    pub layouts: Vec<Value>,
    #[serde(default)]
    pub theme: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Slide {
    pub id: String,
    pub layout_id: String,
    pub number: u32,
    pub width: Length,
    pub height: Length,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<SlideBackground>,
    pub shapes: Vec<SlideShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<FlowContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transitions: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub animations: Vec<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SlideBackground {
    Color(ColorRef),
    Image { image_id: String },
}

/// A shape on a slide. Reuses fixed-mode `Layer` for positioning, plus
/// placeholder semantics from the slide layout system.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SlideShape {
    pub layer: Layer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<PlaceholderKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlaceholderKind {
    Title,
    Subtitle,
    Body,
    Image,
    Chart,
    Table,
    Footer,
    Header,
    SlideNumber,
    DateTime,
    Other,
}

const fn is_false(b: &bool) -> bool {
    !*b
}
