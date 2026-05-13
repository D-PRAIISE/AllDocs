//! Length, units, and 2D geometry primitives shared by all content modes.
//!
//! See UDM_SPEC.md §5.1, §5.2, §7 (Matrix2D).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A length value with an explicit unit. Importers should preserve the
/// unit from the source format when possible; the editor and exporters
/// convert as needed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Length {
    pub value: f64,
    pub unit: Unit,
}

impl Length {
    pub const fn pt(value: f64) -> Self {
        Self {
            value,
            unit: Unit::Pt,
        }
    }
    pub const fn px(value: f64) -> Self {
        Self {
            value,
            unit: Unit::Px,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Px,
    Pt,
    Pc,
    In,
    Cm,
    Mm,
    Em,
    #[serde(rename = "%")]
    Percent,
}

/// Edge values keyed by side (top/right/bottom/left). All sides optional;
/// missing sides mean "no override".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Edges<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<T>,
}

// Manual Default — `derive(Default)` would impose `T: Default`, which we
// don't want. All-None is a valid default regardless of T.
impl<T> Default for Edges<T> {
    fn default() -> Self {
        Self {
            top: None,
            right: None,
            bottom: None,
            left: None,
        }
    }
}

/// Affine 2D transformation matrix in standard PDF/SVG form:
/// `[a b 0; c d 0; e f 1]`, where (e, f) is the translation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Matrix2D {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Matrix2D {
    pub const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_serializes_with_unit() {
        let l = Length::pt(12.5);
        let json = serde_json::to_value(l).unwrap();
        assert_eq!(json, serde_json::json!({ "value": 12.5, "unit": "pt" }));
    }

    #[test]
    fn percent_unit_serializes_as_symbol() {
        let l = Length {
            value: 50.0,
            unit: Unit::Percent,
        };
        let json = serde_json::to_value(l).unwrap();
        assert_eq!(json, serde_json::json!({ "value": 50.0, "unit": "%" }));
    }

    #[test]
    fn edges_skips_none_fields() {
        let e: Edges<Length> = Edges {
            top: Some(Length::pt(10.0)),
            ..Default::default()
        };
        let json = serde_json::to_value(e).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "top": { "value": 10.0, "unit": "pt" } })
        );
    }
}
