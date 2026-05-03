//! Flow-mode content: DOCX, ODT, MD, HTML, EPUB (reflowable), RTF, plain text.
//!
//! See UDM_SPEC.md §6.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::geometry::Length;
use crate::styles::Mark;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct FlowContent {
    pub blocks: Vec<Block>,
}

/// Block-level flow content. Tag: `type`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Paragraph(Paragraph),
    Heading(Heading),
    List(List),
    Table(Table),
    #[serde(rename = "code")]
    CodeBlock(CodeBlock),
    Quote(Quote),
    Divider(Divider),
    Image(ImageBlock),
    Embed(Embed),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Paragraph {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Heading {
    pub level: u8, // 1..=6
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct List {
    pub ordered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    pub items: Vec<ListItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ListItem {
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Table {
    pub rows: Vec<TableRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_widths: Vec<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caption: Vec<Inline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_header: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TableCell {
    pub blocks: Vec<Block>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colspan: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rowspan: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CodeBlock {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Quote {
    pub blocks: Vec<Block>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citation: Vec<Inline>,
}

/// Empty marker block (horizontal rule).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Divider {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImageBlock {
    pub image_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caption: Vec<Inline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment: Option<ImageAlignment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ImageAlignment {
    Left,
    Center,
    Right,
    Inline,
}

/// Generic embed for math, charts, OLE, iframes etc. Payload shape depends on `kind`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Embed {
    pub kind: EmbedKind,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum EmbedKind {
    Math,
    Chart,
    Ole,
    Iframe,
}

// ---- Inlines ----

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inline {
    Text(TextRun),
    Br(LineBreak),
    ImageInline(InlineImage),
    Link(Hyperlink),
    Math(InlineMath),
    Footnote(Footnote),
    Citation(Citation),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TextRun {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct LineBreak {
    #[serde(default, skip_serializing_if = "is_false")]
    pub hard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InlineImage {
    pub image_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<Length>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Hyperlink {
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InlineMath {
    pub source: MathSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MathSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mathml: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Footnote {
    pub id: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Citation {
    pub key: String,
    pub display: Vec<Inline>,
}

const fn is_false(b: &bool) -> bool {
    !*b
}
