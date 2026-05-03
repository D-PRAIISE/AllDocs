//! Sheet-mode content: XLSX, ODS, CSV, Numbers.
//!
//! See UDM_SPEC.md §8. Charts, pivot tables, conditional formats, and
//! protection are stubbed for v0.1 (see §14).

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geometry::Length;

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SheetContent {
    pub sheets: Vec<Sheet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub named_ranges: Vec<NamedRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub defined_names: Vec<DefinedName>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Sheet {
    pub name: String,
    /// Sparse cell map keyed by A1 address.
    #[serde(default)]
    pub cells: HashMap<CellAddress, Cell>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub row_heights: HashMap<u32, Length>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub column_widths: HashMap<String, Length>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<CellRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub charts: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pivot_tables: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditional_formats: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection: Option<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

/// A1-style cell address, e.g. "A1", "AB17".
pub type CellAddress = String;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Cell {
    pub value: CellValue,
    /// Original formula text, e.g. "=SUM(A1:A10)".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    /// Cached display string from the source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<CellComment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hyperlink: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CellComment {
    pub author: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CellValue {
    Number { value: f64 },
    String { value: String },
    Boolean { value: bool },
    /// ISO 8601.
    Date { value: String },
    Error { code: String },
    Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CellRange {
    pub start: CellAddress,
    pub end: CellAddress,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NamedRange {
    pub name: String,
    pub range: CellRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DefinedName {
    pub name: String,
    pub expression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

const fn is_false(b: &bool) -> bool {
    !*b
}
