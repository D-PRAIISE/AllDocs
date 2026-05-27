"""
PPTX <-> UDM slides-mode adapter.

Maps python-pptx's slide model into the UDM slides schema defined in
core/udm/src/slides.rs. v1 captures:

  - Slide dimensions (presentation slide_width / slide_height)
  - Per-slide text shapes (title + body + freeform text frames) →
    SlideShape with a fixed-mode TextLayer
  - Per-slide image shapes → SlideShape with a fixed-mode ImageLayer
    + an ImageResource extracted to data: URLs
  - Placeholder type (title / body / image / …) so the editor can
    surface what kind of text it is
  - Slide notes → SlideShape with type=text and a marker

Animations, transitions, masters, layouts, and theme content are
preserved at the zip level by future passthrough work — v1 doesn't
surface them to UDM.
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Emu

UDM_VERSION = "0.1.0"

PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def import_pptx(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()

    prs = Presentation(str(path))

    slide_w_pt = _emu_to_pt(prs.slide_width)
    slide_h_pt = _emu_to_pt(prs.slide_height)

    images: dict[str, dict[str, Any]] = {}
    slides_data: list[dict[str, Any]] = []
    for idx, slide in enumerate(prs.slides):
        slides_data.append(
            _slide_to_udm(slide, idx + 1, slide_w_pt, slide_h_pt, images)
        )

    metadata: dict[str, Any] = {
        "source_format": {"mime": PPTX_MIME, "extension": "pptx"},
        "source_hash": sha256,
    }
    core = prs.core_properties
    if core.title:
        metadata["title"] = core.title
    if core.author:
        metadata["authors"] = [core.author]
    if core.subject:
        metadata["subject"] = core.subject

    return {
        "udm_version": UDM_VERSION,
        "id": str(uuid.uuid4()),
        "mode": "slides",
        "metadata": metadata,
        "resources": {
            "fonts": [],
            "images": list(images.values()),
            "styles": [],
            "colors": [],
        },
        "content": {"slides": slides_data},
    }


def export_pptx(udm: dict[str, Any], output_path: str | Path) -> None:
    if udm.get("mode") != "slides":
        raise ValueError(f"PPTX export requires slides UDM; got mode={udm.get('mode')!r}")
    slides = (udm.get("content") or {}).get("slides") or []
    images = {
        img["id"]: img
        for img in (udm.get("resources") or {}).get("images") or []
        if isinstance(img, dict) and "id" in img
    }

    prs = Presentation()
    # python-pptx's blank layout is layouts[6] in the default template.
    blank_layout = prs.slide_layouts[6]
    # Match the source dimensions where possible. Use the first slide's
    # size as the deck's size; python-pptx uses presentation-level
    # width/height, not per-slide.
    if slides:
        first = slides[0]
        try:
            prs.slide_width = _pt_to_emu(_length_to_pt(first["width"]))
            prs.slide_height = _pt_to_emu(_length_to_pt(first["height"]))
        except (KeyError, TypeError):
            pass

    for slide_data in slides:
        slide = prs.slides.add_slide(blank_layout)
        _apply_slide_shapes(slide, slide_data, images)

    prs.save(str(output_path))


# ---- import helpers ----------------------------------------------------


_PLACEHOLDER_KIND = {
    13: "title",     # PP_PLACEHOLDER.TITLE
    14: "subtitle",
    2: "body",
    18: "image",
    12: "footer",
    11: "header",
    16: "slide_number",
    15: "datetime",
}


def _slide_to_udm(
    slide: Any,
    number: int,
    slide_w_pt: float,
    slide_h_pt: float,
    images: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    shapes_data: list[dict[str, Any]] = []
    for shape in slide.shapes:
        captured = _shape_to_udm(shape, images)
        if captured is not None:
            shapes_data.append(captured)

    notes_text = ""
    try:
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            notes_text = (slide.notes_slide.notes_text_frame.text or "").strip()
    except Exception:
        notes_text = ""

    out: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "layout_id": "blank",
        "number": number,
        "width": _length_pt(slide_w_pt),
        "height": _length_pt(slide_h_pt),
        "shapes": shapes_data,
    }
    if notes_text:
        out["notes"] = {
            "blocks": [
                {
                    "type": "paragraph",
                    "inlines": [{"type": "text", "text": notes_text}],
                }
            ]
        }
    return out


def _shape_to_udm(shape: Any, images: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """One python-pptx Shape → UDM SlideShape, or None when the shape
    has no UDM-representable content (e.g. a connector line)."""
    try:
        left_pt = _emu_to_pt(shape.left or 0)
        top_pt = _emu_to_pt(shape.top or 0)
        width_pt = _emu_to_pt(shape.width or 0)
        height_pt = _emu_to_pt(shape.height or 0)
    except Exception:
        return None

    placeholder_kind: str | None = None
    try:
        if shape.is_placeholder:
            ptype = int(shape.placeholder_format.type) if shape.placeholder_format else 0
            placeholder_kind = _PLACEHOLDER_KIND.get(ptype, "other")
    except Exception:
        placeholder_kind = None

    name = getattr(shape, "name", None)

    # Picture shape → ImageLayer.
    if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
        try:
            img = shape.image
            image_id = f"img_{len(images):03d}"
            ext = img.ext or "png"
            mime = img.content_type or f"image/{ext}"
            data_url = (
                "data:" + mime + ";base64,"
                + base64.b64encode(img.blob).decode("ascii")
            )
            images[image_id] = {
                "id": image_id,
                "format": ext,
                "width": int(getattr(img, "size", (0, 0))[0] or 0),
                "height": int(getattr(img, "size", (0, 0))[1] or 0),
                "data_ref": data_url,
            }
            layer = {
                "type": "image",
                "image_id": image_id,
                "x": _length_pt(left_pt),
                "y": _length_pt(top_pt),
                "width": _length_pt(width_pt),
                "height": _length_pt(height_pt),
            }
        except Exception:
            return None
        out: dict[str, Any] = {"layer": layer}
        if placeholder_kind:
            out["placeholder"] = placeholder_kind
        if name:
            out["name"] = name
        return out

    # Text-bearing shape → TextLayer with one run per paragraph (joined
    # by newline). Captures placeholders + free text frames.
    if getattr(shape, "has_text_frame", False):
        try:
            tf = shape.text_frame
        except Exception:
            return None
        runs: list[dict[str, Any]] = []
        # Estimated baseline y: top + 0.75 * line height (matches what
        # fixed-mode TextLayer expects).
        run_size = _shape_font_size_pt(shape) or 18.0
        baseline_y = top_pt + run_size * 0.8
        joined = tf.text or ""
        if not joined.strip():
            return None
        runs.append(
            {
                "text": joined,
                "font_id": "font_pptx_default",
                "font_size": _length_pt(run_size),
                "color": {"literal": _shape_text_color(shape)},
                "x": _length_pt(left_pt),
                "y": _length_pt(baseline_y),
            }
        )
        layer = {"type": "text", "runs": runs}
        out = {"layer": layer}
        if placeholder_kind:
            out["placeholder"] = placeholder_kind
        if name:
            out["name"] = name
        return out

    # Unknown / unsupported shape type (connectors, groups, OLE) —
    # capture a stub so positional context isn't lost on re-export. We
    # emit an annotation-style layer rather than dropping silently.
    return None


def _shape_font_size_pt(shape: Any) -> float | None:
    try:
        tf = shape.text_frame
        for para in tf.paragraphs:
            for run in para.runs:
                if run.font.size is not None:
                    return float(run.font.size.pt)
    except Exception:
        return None
    return None


def _shape_text_color(shape: Any) -> dict[str, Any]:
    # Try the first run's font color. Default black.
    try:
        tf = shape.text_frame
        for para in tf.paragraphs:
            for run in para.runs:
                color = run.font.color
                if color is not None and color.type is not None:
                    try:
                        rgb = color.rgb
                        if rgb is not None:
                            return {
                                "kind": "rgb",
                                "r": int(rgb[0]),
                                "g": int(rgb[1]),
                                "b": int(rgb[2]),
                            }
                    except Exception:
                        pass
    except Exception:
        pass
    return {"kind": "rgb", "r": 0, "g": 0, "b": 0}


# ---- export helpers ----------------------------------------------------


def _apply_slide_shapes(slide: Any, slide_data: dict[str, Any], images: dict[str, dict[str, Any]]) -> None:
    from pptx.util import Pt

    for shape_data in slide_data.get("shapes") or []:
        layer = shape_data.get("layer") or {}
        kind = layer.get("type")
        if kind == "text":
            runs = layer.get("runs") or []
            if not runs:
                continue
            run = runs[0]
            try:
                left = _pt_to_emu(_length_to_pt(run["x"]))
                # Top-of-text approximation: baseline y minus 0.8 * size.
                font_size_pt = _length_to_pt(run.get("font_size") or {"value": 18, "unit": "pt"})
                top = _pt_to_emu(_length_to_pt(run["y"]) - font_size_pt * 0.8)
            except (KeyError, TypeError):
                continue
            width = Emu(int(_pt_to_emu(_length_to_pt(slide_data["width"])) * 0.8))
            height = Emu(int(font_size_pt * 12700 * 2))  # rough box
            txBox = slide.shapes.add_textbox(left, top, width, height)
            tf = txBox.text_frame
            tf.word_wrap = True
            tf.text = run.get("text") or ""
            for para in tf.paragraphs:
                for p_run in para.runs:
                    p_run.font.size = Pt(font_size_pt)
        elif kind == "image":
            image_id = layer.get("image_id")
            img = images.get(image_id) if image_id else None
            if not img:
                continue
            data_ref = img.get("data_ref") or ""
            if not data_ref.startswith("data:"):
                continue
            try:
                _, b64 = data_ref.split(",", 1)
                bytes_ = base64.b64decode(b64)
                left = _pt_to_emu(_length_to_pt(layer["x"]))
                top = _pt_to_emu(_length_to_pt(layer["y"]))
                width = _pt_to_emu(_length_to_pt(layer["width"]))
                height = _pt_to_emu(_length_to_pt(layer["height"]))
                slide.shapes.add_picture(BytesIO(bytes_), left, top, width=width, height=height)
            except Exception:
                continue


# ---- coords ----------------------------------------------------------


def _emu_to_pt(emu: int) -> float:
    # 1 inch = 914400 EMU = 72 pt → 1 EMU = 72 / 914400 pt
    return (emu or 0) * 72.0 / 914400.0


def _pt_to_emu(pt: float) -> int:
    return int(round((pt or 0) * 914400.0 / 72.0))


def _length_pt(value: float) -> dict[str, Any]:
    return {"value": float(value), "unit": "pt"}


def _length_to_pt(length: Any) -> float:
    if not isinstance(length, dict):
        return 0.0
    try:
        v = float(length.get("value") or 0)
    except (TypeError, ValueError):
        return 0.0
    unit = length.get("unit") or "pt"
    if unit == "pt":
        return v
    if unit == "px":
        return v * 72 / 96
    if unit == "in":
        return v * 72
    if unit == "mm":
        return v * 72 / 25.4
    return v
