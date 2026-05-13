"""
UDM -> PDF exporter.

The inverse of importer.py: take a UDM v0.1.0 document and produce a PDF.

Scope (v0.1):
  - Fixed mode only (mode="fixed"). Other modes raise NotImplementedError.
  - Text runs and image layers. Shapes, annotations, and forms are
    skipped silently in v0.1 (will land in v0.2).
  - Fonts: if a FontResource has a data_ref pointing at a local font file,
    that file is embedded. Otherwise the closest PDF base-14 font (Helvetica
    family) is selected based on weight + style.
  - Images: if data_ref is a local path or relative URL, the bytes are loaded
    and embedded. "xref:N" data_refs (raw importer output without asset
    extraction) are skipped — the importer must be run with --assets-dir
    if you want round-trip-able images.

Lessons applied (memory/project_alldocs_pdf_adapter.md):
  #1 (subset fonts): fall back to base-14 when no usable font file exists
  #3 (off-page placements): preserved verbatim — Length values copied through
  #4 (multi-placement images): each ImageLayer is independent; resource is
     loaded once but inserted at each placement
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pymupdf

# Approximate descender as a fraction of fontsize.
# UDM PositionedTextRun.y is bbox-bottom (set by importer from span['bbox'][3]),
# while pymupdf.insert_text expects the BASELINE. The shift between the two is
# the descender; 0.2 is a serviceable approximation for Latin fonts.
# This will drift slightly for non-Latin scripts and unusual fonts; v0.2
# importer should record the true baseline so we don't need this adjustment.
DESCENDER_FRACTION = 0.2


def export_pdf(
    udm: dict[str, Any],
    output_path: str | Path,
    base_dir: str | Path | None = None,
) -> None:
    """Render a UDM document to a PDF file at ``output_path``.

    ``base_dir`` is used to resolve relative ``data_ref`` URLs in
    ``udm.resources``. It defaults to the current working directory.
    """
    if udm.get("mode") != "fixed":
        raise NotImplementedError(
            f"Export only supports mode='fixed' in v0.1; got mode={udm.get('mode')!r}"
        )

    base = Path(base_dir) if base_dir else Path.cwd()

    doc = pymupdf.open()
    try:
        font_handles = _resolve_fonts(udm["resources"]["fonts"], base)

        for page_data in udm["content"]["pages"]:
            _render_page(doc, page_data, udm["resources"], font_handles, base)

        _apply_metadata(doc, udm.get("metadata", {}))
        doc.save(str(output_path), garbage=4, deflate=True, clean=True)
    finally:
        doc.close()


# ---- Fonts ---------------------------------------------------------------

# Each font_id maps to either:
#   ("file", absolute_path_to_ttf_or_otf)  — embed via fontfile=
#   ("base14", pdf_short_name)             — use a built-in PDF font
FontHandle = tuple[str, str]


def _resolve_fonts(
    fonts: list[dict[str, Any]],
    base: Path,
) -> dict[str, FontHandle]:
    handles: dict[str, FontHandle] = {}
    for font in fonts:
        font_id = font["id"]
        data_ref = font.get("data_ref")
        if data_ref and not data_ref.startswith(("http://", "https://", "xref:")):
            font_path = _resolve_relative(base, data_ref)
            if font_path.exists() and _font_usable_for_unicode(font_path):
                handles[font_id] = ("file", str(font_path))
                continue
        handles[font_id] = ("base14", _base14_for(font))
    return handles


# Latin sample used to probe whether an extracted font's cmap can resolve
# Unicode codepoints. Subset fonts extracted from PDFs with Identity-H /
# CID encoding (Type0) often have no usable Unicode cmap — re-embedding
# them via insert_text(fontfile=) produces missing glyphs (the "boxes"
# bug surfaced on CSCA + Hygeia PDFs on 2026-05-13). When the probe
# fails, we fall back to PDF base-14 (Times/Helvetica family).
# Threshold of 70% is a hedge for subsets that legitimately lack
# uncommon glyphs but still have most of the alphabet.
_UNICODE_PROBE = "TheQuickBrownFx0123 .,-"
_UNICODE_PROBE_THRESHOLD = 0.7


def _font_usable_for_unicode(font_path: Path) -> bool:
    """True if PyMuPDF can resolve common Latin Unicode codepoints to glyphs
    in the font file at ``font_path``. Used to skip extracted subset fonts
    that lack a usable cmap (typically CIDFont extracts from Identity-H
    PDFs). See PDF-adapter lesson #13."""
    try:
        font = pymupdf.Font(fontfile=str(font_path))
    except Exception:
        return False
    hits = 0
    for ch in _UNICODE_PROBE:
        try:
            if font.has_glyph(ord(ch)):
                hits += 1
        except Exception:
            return False
    return hits >= len(_UNICODE_PROBE) * _UNICODE_PROBE_THRESHOLD


def _base14_for(font: dict[str, Any]) -> str:
    """Pick the closest PDF base-14 short name for a font's weight + style.

    PyMuPDF base-14 short names:
      helv (Helvetica), hebo (Helvetica-Bold), heit (Helvetica-Oblique),
      hebi (Helvetica-BoldOblique).
    """
    weight = int(font.get("weight", 400))
    style = font.get("style", "normal")
    is_bold = weight >= 600
    is_italic = style in ("italic", "oblique")
    if is_bold and is_italic:
        return "hebi"
    if is_bold:
        return "hebo"
    if is_italic:
        return "heit"
    return "helv"


# ---- Pages ---------------------------------------------------------------


_LAYER_ORDER = {"image": 0, "shape": 1, "annotation": 2, "text": 3, "form": 4}


def _render_page(
    doc: pymupdf.Document,
    page_data: dict[str, Any],
    resources: dict[str, Any],
    font_handles: dict[str, FontHandle],
    base: Path,
) -> None:
    width_pt = _length_to_pt(page_data["width"])
    height_pt = _length_to_pt(page_data["height"])
    page = doc.new_page(width=width_pt, height=height_pt)

    # Reorder layers so images render below text. The importer currently
    # appends text first then images, but PDF z-order is bottom-up; if we
    # used import order the images would cover the text. Long-term the
    # importer should capture true content-stream order so we don't need
    # this heuristic. (See project_alldocs_pdf_adapter.md lesson #11.)
    layers = sorted(
        page_data.get("layers", []),
        key=lambda layer: _LAYER_ORDER.get(layer.get("type", ""), 99),
    )
    for layer in layers:
        kind = layer.get("type")
        if kind == "text":
            _render_text_layer(page, layer, font_handles)
        elif kind == "image":
            _render_image_layer(page, layer, resources, base)
        elif kind == "shape":
            _render_shape_layer(page, layer)
        # annotation / form: v0.2


def _render_text_layer(
    page: pymupdf.Page,
    layer: dict[str, Any],
    font_handles: dict[str, FontHandle],
) -> None:
    for run in layer.get("runs", []):
        text = run.get("text", "")
        if not text:
            continue
        font_id = run["font_id"]
        size = _length_to_pt(run["font_size"])
        color = _color_to_rgb(run["color"])
        x = _length_to_pt(run["x"])
        # Bbox-bottom -> baseline approximation. See DESCENDER_FRACTION above.
        y = _length_to_pt(run["y"]) - size * DESCENDER_FRACTION

        kind, value = font_handles.get(font_id, ("base14", "helv"))
        if kind == "file":
            page.insert_text(
                (x, y),
                text,
                fontsize=size,
                color=color,
                fontfile=value,
                fontname=f"udm_{font_id}",
            )
        else:
            page.insert_text(
                (x, y),
                text,
                fontsize=size,
                color=color,
                fontname=value,
            )


def _render_shape_layer(page: pymupdf.Page, layer: dict[str, Any]) -> None:
    """v0.1 shape rendering: solid-fill rectangles only.
    Curves, paths, gradients, and patterns land in v0.2."""
    geom = layer.get("geometry") or {}
    if geom.get("kind") != "rect":
        return
    rect = pymupdf.Rect(
        _length_to_pt(geom["x"]),
        _length_to_pt(geom["y"]),
        _length_to_pt(geom["x"]) + _length_to_pt(geom["w"]),
        _length_to_pt(geom["y"]) + _length_to_pt(geom["h"]),
    )

    fill_color = None
    fill = layer.get("fill")
    if isinstance(fill, dict) and fill.get("kind") == "solid":
        fill_color = _color_to_rgb(fill.get("color", {}))

    stroke_color = None
    stroke_width = 0.0
    stroke = layer.get("stroke")
    if isinstance(stroke, dict):
        paint = stroke.get("paint") or {}
        if paint.get("kind") == "solid":
            stroke_color = _color_to_rgb(paint.get("color", {}))
        sw = stroke.get("width")
        if sw:
            stroke_width = _length_to_pt(sw)

    if fill_color is None and stroke_color is None:
        return

    page.draw_rect(
        rect,
        color=stroke_color,
        fill=fill_color,
        width=stroke_width,
        fill_opacity=float(layer.get("opacity", 1)),
    )


def _render_image_layer(
    page: pymupdf.Page,
    layer: dict[str, Any],
    resources: dict[str, Any],
    base: Path,
) -> None:
    image_id = layer["image_id"]
    img = next((i for i in resources.get("images", []) if i["id"] == image_id), None)
    if img is None:
        return
    data_ref = img.get("data_ref", "")
    if not data_ref or data_ref.startswith(("xref:", "http://", "https://")):
        # No local file we can read.
        return
    img_path = _resolve_relative(base, data_ref)
    if not img_path.exists():
        return

    rect = pymupdf.Rect(
        _length_to_pt(layer["x"]),
        _length_to_pt(layer["y"]),
        _length_to_pt(layer["x"]) + _length_to_pt(layer["width"]),
        _length_to_pt(layer["y"]) + _length_to_pt(layer["height"]),
    )
    page.insert_image(
        rect,
        filename=str(img_path),
        keep_proportion=False,
        rotate=int(layer.get("rotation") or 0),
    )


# ---- Metadata ------------------------------------------------------------


def _apply_metadata(doc: pymupdf.Document, metadata: dict[str, Any]) -> None:
    pdf_meta: dict[str, str] = {}
    if metadata.get("title"):
        pdf_meta["title"] = str(metadata["title"])
    authors = metadata.get("authors")
    if authors:
        pdf_meta["author"] = ", ".join(str(a) for a in authors)
    if metadata.get("subject"):
        pdf_meta["subject"] = str(metadata["subject"])
    if metadata.get("keywords"):
        pdf_meta["keywords"] = ", ".join(str(k) for k in metadata["keywords"])
    pdf_meta["producer"] = "AllDocs pdf-adapter"
    pdf_meta["creator"] = "AllDocs pdf-adapter (UDM exporter)"
    if pdf_meta:
        doc.set_metadata(pdf_meta)


# ---- Helpers -------------------------------------------------------------


def _resolve_relative(base: Path, data_ref: str) -> Path:
    """Resolve a UDM data_ref (a relative URL/path) against a base directory."""
    # Strip leading slash so absolute-looking refs like "/uploads/foo/x.png"
    # resolve relative to base, not the filesystem root.
    cleaned = data_ref.lstrip("/")
    return (base / cleaned).resolve()


def _length_to_pt(length: dict[str, Any]) -> float:
    """Convert a UDM Length to PDF points."""
    value = float(length["value"])
    unit = length.get("unit", "pt")
    if unit == "pt":
        return value
    if unit == "px":
        return value * 72.0 / 96.0
    if unit == "in":
        return value * 72.0
    if unit == "cm":
        return value / 2.54 * 72.0
    if unit == "mm":
        return value / 25.4 * 72.0
    if unit == "pc":
        return value * 12.0
    if unit == "em":
        return value * 12.0  # context-free approximation
    if unit == "%":
        return value
    return value


def _color_to_rgb(color_ref: dict[str, Any]) -> tuple[float, float, float]:
    """Convert a UDM ColorRef literal to a 0..1 RGB tuple for PyMuPDF."""
    literal = color_ref.get("literal") if color_ref else None
    if not literal:
        return (0.0, 0.0, 0.0)
    kind = literal.get("kind")
    if kind == "rgb":
        return (
            float(literal["r"]) / 255.0,
            float(literal["g"]) / 255.0,
            float(literal["b"]) / 255.0,
        )
    if kind == "hex":
        h = str(literal.get("hex", "")).lstrip("#")
        if len(h) == 6:
            return (
                int(h[0:2], 16) / 255.0,
                int(h[2:4], 16) / 255.0,
                int(h[4:6], 16) / 255.0,
            )
    if kind == "cmyk":
        c, m, y_, k = literal["c"], literal["m"], literal["y"], literal["k"]
        return (
            (1 - c) * (1 - k),
            (1 - m) * (1 - k),
            (1 - y_) * (1 - k),
        )
    return (0.0, 0.0, 0.0)


def export_pdf_from_file(udm_path: str | Path, output_path: str | Path) -> None:
    """Convenience wrapper: load a UDM JSON file from disk and export it."""
    udm_path = Path(udm_path)
    udm = json.loads(udm_path.read_text(encoding="utf-8"))
    export_pdf(udm, output_path, base_dir=udm_path.parent)
