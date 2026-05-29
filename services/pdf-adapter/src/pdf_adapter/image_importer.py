"""
Raw-image → UDM importer.

Wraps a single image file as a one-page fixed-mode UDM document so
the existing fixed-mode editor can OCR-edit the text on it. The
output UDM is structurally identical to what we'd get from importing
a scanned PDF: one ImageLayer covering the page + an OCR'd
TextLayer with editable runs.

Supported inputs: any PIL-readable image format (PNG, JPEG, WebP,
GIF — first frame, BMP, TIFF — first page).

Output mode: "fixed". The PDF exporter handles it directly via the
existing render path so users can download as PDF after editing.
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from pathlib import Path
from typing import Any

from . import _ocr

UDM_VERSION = "0.1.0"

# Treat raw uploads at the standard web DPI so each input pixel maps to
# 0.75pt. Reasonable default for arbitrary inputs; users who want a
# different real-world size can rescale before upload.
_INPUT_DPI = 96
_PX_TO_PT = 72.0 / _INPUT_DPI


def import_image(
    path: str | Path,
    *,
    source_url: str | None = None,
    enable_ocr: bool = True,
    ocr_lang: str | None = None,
    ocr_granularity: str = "line",
) -> dict[str, Any]:
    """Read an image file and produce a single-page fixed UDM document.

    Same OCR plumbing as the PDF importer (lang + granularity).
    """
    from PIL import Image

    path = Path(path)
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()

    with Image.open(path) as im:
        # Normalise to RGB so OCR + the canvas have a consistent
        # pixel layout (PIL's palette / RGBA modes confuse Tesseract
        # under some configurations).
        rgb = im.convert("RGB")
        width_px, height_px = rgb.size
        # The format the file was actually stored as — used for the
        # data URL mime type and the source_format metadata. Falls
        # back to PNG when PIL can't tell us.
        fmt = (im.format or "PNG").lower()
        if fmt == "jpg":
            fmt = "jpeg"

    width_pt = width_px * _PX_TO_PT
    height_pt = height_px * _PX_TO_PT

    image_id = "img_001"
    mime = f"image/{fmt}"
    data_url = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")

    image_resource: dict[str, Any] = {
        "id": image_id,
        "format": "png" if fmt not in ("png", "jpeg", "webp") else fmt,
        "width": width_px,
        "height": height_px,
        "data_ref": data_url,
    }

    layers: list[dict[str, Any]] = [
        {
            "type": "image",
            "image_id": image_id,
            "x": {"value": 0, "unit": "pt"},
            "y": {"value": 0, "unit": "pt"},
            "width": {"value": width_pt, "unit": "pt"},
            "height": {"value": height_pt, "unit": "pt"},
            "_meta": {"z_index": 0},
        }
    ]

    fonts: list[dict[str, Any]] = []
    if enable_ocr and _ocr.tesseract_available():
        try:
            result = _ocr.ocr_image(
                rgb,
                scale_to_pt=_PX_TO_PT,
                lang=ocr_lang,
                granularity=ocr_granularity,
            )
        except RuntimeError:
            result = None
        if result and result.runs:
            ocr_font_id = "font_000"
            fonts.append(
                {
                    "id": ocr_font_id,
                    "family": "sans-serif",
                    "weight": 400,
                    "style": "normal",
                    "source": "substituted",
                    "_meta": {"ocr": True},
                }
            )
            runs: list[dict[str, Any]] = []
            for r in result.runs:
                runs.append(
                    {
                        "text": r.text,
                        "font_id": ocr_font_id,
                        "font_size": {"value": r.font_size, "unit": "pt"},
                        "color": {
                            "literal": {
                                "kind": "rgb",
                                "r": r.color[0],
                                "g": r.color[1],
                                "b": r.color[2],
                            }
                        },
                        "x": {"value": r.x0, "unit": "pt"},
                        "y": {"value": r.y1, "unit": "pt"},
                        "ocr": {
                            "confidence": r.confidence,
                            "engine": result.engine,
                        },
                        "_meta": {
                            "ocr_width": r.x1 - r.x0,
                            "ocr_text": r.text,
                            "ocr_bg": list(r.bg_color),
                            "z_index": 1,
                        },
                    }
                )
            layers.append({"type": "text", "runs": runs})

    metadata: dict[str, Any] = {
        "source_format": {"mime": mime, "extension": fmt},
        "source_hash": sha256,
    }
    if source_url:
        # Image passthrough isn't meaningful (the source IS the image —
        # no re-render involved), but record the URL so the patch
        # exporter's bookkeeping recognises the asset.
        metadata.setdefault("custom_properties", {})["image_source_url"] = source_url

    return {
        "udm_version": UDM_VERSION,
        "id": str(uuid.uuid4()),
        "mode": "fixed",
        "metadata": metadata,
        "resources": {
            "fonts": fonts,
            "images": [image_resource],
            "styles": [],
            "colors": [],
        },
        "content": {
            "pages": [
                {
                    "number": 1,
                    "width": {"value": width_pt, "unit": "pt"},
                    "height": {"value": height_pt, "unit": "pt"},
                    "layers": layers,
                    "rotation": 0,
                    "_meta": {"source_page": 0},
                }
            ]
        },
    }
