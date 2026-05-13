//! Style properties, colors, and inline marks.
//!
//! See UDM_SPEC.md §5 (Resources / StyleProperties), §6.1 (Marks).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::geometry::{Edges, Length};

/// Reusable style block referenced from content via `style_id`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StyleProperties {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<ColorRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alignment: Option<Alignment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<LineHeight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<Length>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<Edges<Length>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<Edges<Length>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<BorderSet>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    Left,
    Right,
    Center,
    Justify,
    Start,
    End,
}

/// Line height: either a unitless multiplier (e.g. 1.5) or an explicit length.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum LineHeight {
    Multiplier(f64),
    Length(Length),
}

/// Color reference: either a literal value or a pointer to a named ColorResource.
/// Exactly one of `ref` / `literal` should be present; we don't enforce that
/// at the type level (it's a spec validation concern, see UDM_SPEC.md §12).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ColorRef {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<ColorValue>,
}

/// Concrete color value in one of several color spaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ColorValue {
    Rgb {
        r: u8,
        g: u8,
        b: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        a: Option<u8>,
    },
    Cmyk {
        c: f64,
        m: f64,
        y: f64,
        k: f64,
    },
    Hex {
        hex: String,
    },
    Named {
        name: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BorderSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<Border>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Border>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<Border>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Border>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Border {
    pub width: Length,
    pub style: BorderStyle,
    pub color: ColorRef,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyle {
    Solid,
    Dashed,
    Dotted,
    Double,
    None,
}

/// Inline-level formatting overrides that sit on top of a TextRun's `style_id`.
/// Tagged enum: serialized as `{ "type": "bold" }`, `{ "type": "color", "color": ... }`, etc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Mark {
    Bold,
    Italic,
    Underline,
    Strikethrough,
    Superscript,
    Subscript,
    Code,
    Color { color: ColorRef },
    Highlight { color: ColorRef },
    Font { font_id: String },
    Size { size: Length },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_value_rgb_round_trip() {
        let c = ColorValue::Rgb {
            r: 255,
            g: 128,
            b: 64,
            a: None,
        };
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "rgb", "r": 255, "g": 128, "b": 64 })
        );
        let back: ColorValue = serde_json::from_value(json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn mark_bold_serializes_as_tagged() {
        let m = Mark::Bold;
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            serde_json::json!({ "type": "bold" })
        );
    }

    #[test]
    fn mark_with_payload() {
        let m = Mark::Color {
            color: ColorRef {
                reference: None,
                literal: Some(ColorValue::Hex {
                    hex: "#ff0000".into(),
                }),
            },
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["type"], "color");
        assert_eq!(json["color"]["literal"]["kind"], "hex");
    }
}
