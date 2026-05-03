//! Hybrid-mode content: documents that mix multiple content modes.
//!
//! See UDM_SPEC.md §10. Examples: a PDF with reflow projections per page,
//! EPUB3 with both reflowable and fixed-layout sections.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    document::Mode, fixed::FixedContent, flow::FlowContent, sheet::SheetContent,
    slides::SlidesContent,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HybridContent {
    /// Which mode the document is "primarily" in. Editor uses this to pick
    /// the default editing tool and toolbar.
    pub primary: Mode,
    pub layers: HybridLayers,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct HybridLayers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed: Option<FixedContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<SheetContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slides: Option<SlidesContent>,
}
