//! Universal Document Model (UDM) — the canonical IR for AllDocs.
//!
//! Every format adapter (PDF, DOCX, XLSX, PPTX, etc.) imports into UDM and
//! exports from UDM. This crate is the source of truth for the document
//! model; the `proto/udm.schema.json` JSON Schema is auto-generated from
//! these types via the `gen_schema` binary.
//!
//! Spec: see `docs/UDM_SPEC.md` for the human-readable description and the
//! field-by-field meanings. This crate's types must match the spec exactly;
//! changes here require a corresponding spec edit and a version bump.
#![doc(html_root_url = "https://docs.rs/udm/0.1.0")]

pub mod document;
pub mod fixed;
pub mod flow;
pub mod geometry;
pub mod hybrid;
pub mod resources;
pub mod sheet;
pub mod slides;
pub mod styles;

// Re-exports for convenient `use udm::Document;` style imports.
pub use document::{Document, Metadata, Mode, SourceFormat};
pub use fixed::{
    FixedContent, FormLayer, ImageLayer, Layer, Page, PositionedTextRun, ShapeLayer, TextLayer,
};
pub use flow::{
    Block, Embed, FlowContent, Heading, ImageBlock, Inline, List, ListItem, Paragraph, Quote,
    Table, TableCell, TableRow, TextRun,
};
pub use geometry::{Edges, Length, Matrix2D, Unit};
pub use hybrid::HybridContent;
pub use resources::{ColorResource, FontResource, ImageResource, Resources, StyleResource};
pub use sheet::{Cell, CellAddress, CellRange, CellValue, Sheet, SheetContent};
pub use slides::{Slide, SlideShape, SlidesContent};
pub use styles::{Border, BorderSet, BorderStyle, ColorRef, ColorValue, Mark, StyleProperties};

/// Version of the UDM spec this crate targets. Follows SemVer.
/// Bumped according to the rules in UDM_SPEC.md §11.
pub const UDM_VERSION: &str = "0.1.0";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo() {
        // The crate version and the UDM spec version are kept in lockstep
        // for v0.x. We may relax this when v1.0 ships.
        assert_eq!(UDM_VERSION, env!("CARGO_PKG_VERSION"));
    }
}
