"""
PDF -> UDM importer.

Targets UDM v0.1.0 (see docs/UDM_SPEC.md).

Lessons baked in (memory/project_alldocs_pdf_adapter.md):

  1. Embedded fonts may be subsets — flagged via _meta.subset so the editor
     knows to fall back to a full font for glyphs not in the subset.
  2. Image placements can extend off-page; full transform is preserved.
  3. Multiple placements of the same image share one image_id.
  4. Background colors are NOT sampled; only structural layers are recorded.

Asset extraction (optional):
  If `assets_dir` is passed to import_pdf, embedded images and fonts are
  written to disk and the corresponding `data_ref` values in the UDM
  resources are rewritten as relative URLs (joined with `assets_url_prefix`).
  This lets the web viewer load real image and font files without further
  processing.
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

import pymupdf

UDM_VERSION = "0.1.0"

WEIGHT_NAMES: dict[str, int] = {
    "Thin": 100,
    "Hairline": 100,
    "ExtraLight": 200,
    "UltraLight": 200,
    "Light": 300,
    "Regular": 400,
    "Normal": 400,
    "Book": 400,
    "Medium": 500,
    "SemiBold": 600,
    "DemiBold": 600,
    "Bold": 700,
    "ExtraBold": 800,
    "UltraBold": 800,
    "Black": 900,
    "Heavy": 900,
}


def import_pdf(
    path: str | Path,
    assets_dir: str | Path | None = None,
    assets_url_prefix: str = "",
) -> dict[str, Any]:
    """Read a PDF file and produce a UDM v0.1.0 document.

    If ``assets_dir`` is given, embedded images and fonts are extracted to
    that directory under ``images/`` and ``fonts/``. Resource ``data_ref``
    values in the returned UDM are rewritten as relative URLs of the form
    ``{assets_url_prefix}/images/<id>.<ext>`` (or ``images/<id>.<ext>`` if
    no prefix is given). When ``assets_dir`` is None, ``data_ref`` is left
    as the opaque ``xref:N`` form.

    Returns a dict ready to be serialized as UDM JSON.
    """
    path = Path(path)
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()

    doc = pymupdf.open(stream=raw, filetype="pdf")
    try:
        fonts: dict[str, dict[str, Any]] = {}
        images: dict[int, dict[str, Any]] = {}
        pages: list[dict[str, Any]] = []

        for page_idx, page in enumerate(doc):
            pages.append(_page_to_udm(page, page_idx + 1, fonts, images, doc))

        native_meta = doc.metadata or {}

        metadata: dict[str, Any] = {
            "source_format": {
                "mime": "application/pdf",
                "extension": "pdf",
            },
            "source_hash": sha256,
        }
        if native_meta.get("producer"):
            metadata["source_format"]["producer"] = native_meta["producer"]
        if native_meta.get("title"):
            metadata["title"] = native_meta["title"]
        if native_meta.get("author"):
            metadata["authors"] = [native_meta["author"]]
        if native_meta.get("subject"):
            metadata["subject"] = native_meta["subject"]
        if native_meta.get("keywords"):
            metadata["keywords"] = [k.strip() for k in native_meta["keywords"].split(",") if k.strip()]
        if native_meta.get("creationDate"):
            metadata["created_at"] = native_meta["creationDate"]
        if native_meta.get("modDate"):
            metadata["modified_at"] = native_meta["modDate"]

        udm = {
            "udm_version": UDM_VERSION,
            "id": str(uuid.uuid4()),
            "mode": "fixed",
            "metadata": metadata,
            "resources": {
                "fonts": list(fonts.values()),
                "images": list(images.values()),
                "styles": [],
                "colors": [],
            },
            "content": {"pages": pages},
        }

        if assets_dir is not None:
            _extract_assets(udm, doc, Path(assets_dir), assets_url_prefix)

        return udm
    finally:
        doc.close()


def _extract_assets(
    udm: dict[str, Any],
    doc: pymupdf.Document,
    assets_dir: Path,
    url_prefix: str,
) -> None:
    """Extract images and fonts referenced by the UDM to disk and rewrite
    resource ``data_ref`` values to relative URLs."""
    images_dir = assets_dir / "images"
    fonts_dir = assets_dir / "fonts"
    images_dir.mkdir(parents=True, exist_ok=True)
    fonts_dir.mkdir(parents=True, exist_ok=True)

    prefix = url_prefix.rstrip("/")

    def join(*parts: str) -> str:
        return "/".join(p for p in parts if p)

    for img in udm["resources"]["images"]:
        ref = img.get("data_ref", "")
        if not ref.startswith("xref:"):
            continue
        try:
            xref = int(ref.removeprefix("xref:"))
        except ValueError:
            continue
        info = doc.extract_image(xref)
        ext = info["ext"]
        filename = f"{img['id']}.{ext}"
        (images_dir / filename).write_bytes(info["image"])
        img["data_ref"] = join(prefix, "images", filename)

    for font in udm["resources"]["fonts"]:
        meta = font.get("_meta") or {}
        xref = meta.get("xref")
        if not xref:
            continue
        try:
            info = doc.extract_font(xref)
        except (RuntimeError, ValueError):
            continue
        if not info or len(info) < 4:
            continue
        ext, content = info[1], info[3]
        if not content:
            continue
        filename = f"{font['id']}.{ext or 'bin'}"
        (fonts_dir / filename).write_bytes(content)
        font["data_ref"] = join(prefix, "fonts", filename)


def _page_to_udm(
    page: pymupdf.Page,
    number: int,
    fonts: dict[str, dict[str, Any]],
    images: dict[int, dict[str, Any]],
    doc: pymupdf.Document,
) -> dict[str, Any]:
    layers: list[dict[str, Any]] = []

    # Build a clean-name -> (prefixed_basefont, xref) map from the page's
    # font table. span["font"] returns the base name with the subset prefix
    # stripped, so we can't detect subsetting from the span alone; this map
    # gives us the truth (and the xref for asset extraction).
    span_to_font_info: dict[str, tuple[str, int]] = {}
    for entry in page.get_fonts(full=True):
        xref = entry[0]
        basefont = entry[3]
        cleaned = basefont.split("+", 1)[-1] if _looks_like_subset(basefont) else basefont
        span_to_font_info.setdefault(cleaned, (basefont, xref))

    text_runs: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:  # 0 = text, 1 = image
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span.get("text"):
                    continue
                # Use the prefixed basefont if known so subset detection works.
                basefont, font_xref = span_to_font_info.get(span["font"], (span["font"], 0))
                text_runs.append(
                    {
                        "text": span["text"],
                        "font_id": _ensure_font(fonts, basefont, font_xref),
                        "font_size": _length(span["size"], "pt"),
                        "color": {"literal": _color_int_to_value(span["color"])},
                        "x": _length(span["bbox"][0], "pt"),
                        "y": _length(span["bbox"][3], "pt"),
                    }
                )
    if text_runs:
        layers.append({"type": "text", "runs": text_runs})

    for img_info in page.get_images(full=True):
        xref = img_info[0]
        image_id = _ensure_image(images, xref, doc)
        for rect in page.get_image_rects(xref):
            layers.append(
                {
                    "type": "image",
                    "image_id": image_id,
                    "x": _length(rect.x0, "pt"),
                    "y": _length(rect.y0, "pt"),
                    "width": _length(rect.width, "pt"),
                    "height": _length(rect.height, "pt"),
                }
            )

    # Vector drawings — filled/stroked rectangles capture page backgrounds and
    # column dividers that Canva and other design tools rely on. v0.1 captures
    # only rect ops with solid fills/strokes; curves, lines, and gradients
    # land in v0.2.
    layers.extend(_shape_layers_from_drawings(page))

    return {
        "number": number,
        "width": _length(page.rect.width, "pt"),
        "height": _length(page.rect.height, "pt"),
        "layers": layers,
    }


def _shape_layers_from_drawings(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Convert page.get_drawings() output into UDM ShapeLayers.
    Currently captures rectangles only; curves and lines are skipped."""
    out: list[dict[str, Any]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return out

    for d in drawings:
        fill = d.get("fill")
        stroke = d.get("color")
        if fill is None and stroke is None:
            continue
        for item in d.get("items", []):
            if not item or item[0] != "re":
                continue
            rect = item[1]
            try:
                w = float(rect.width)
                h = float(rect.height)
            except AttributeError:
                continue
            if w <= 0 or h <= 0:
                continue
            layer: dict[str, Any] = {
                "type": "shape",
                "geometry": {
                    "kind": "rect",
                    "x": _length(rect.x0, "pt"),
                    "y": _length(rect.y0, "pt"),
                    "w": _length(w, "pt"),
                    "h": _length(h, "pt"),
                },
            }
            if fill is not None:
                layer["fill"] = {
                    "kind": "solid",
                    "color": {"literal": _color_tuple_to_value(fill)},
                }
            stroke_width = float(d.get("width") or 0)
            if stroke is not None and stroke_width > 0:
                layer["stroke"] = {
                    "paint": {
                        "kind": "solid",
                        "color": {"literal": _color_tuple_to_value(stroke)},
                    },
                    "width": _length(stroke_width, "pt"),
                }
            opacity = d.get("fill_opacity")
            if opacity is not None and 0 <= float(opacity) < 1:
                layer["opacity"] = float(opacity)
            out.append(layer)
    return out


def _color_tuple_to_value(c: Any) -> dict[str, Any]:
    """Convert PyMuPDF's RGB color tuple (0..1 floats) to a UDM ColorValue."""
    if isinstance(c, (tuple, list)) and len(c) >= 3:
        return {
            "kind": "rgb",
            "r": int(round(float(c[0]) * 255)),
            "g": int(round(float(c[1]) * 255)),
            "b": int(round(float(c[2]) * 255)),
        }
    return {"kind": "rgb", "r": 0, "g": 0, "b": 0}


def _length(value: float, unit: str) -> dict[str, Any]:
    return {"value": float(value), "unit": unit}


def _color_int_to_value(color_int: int) -> dict[str, Any]:
    return {
        "kind": "rgb",
        "r": (color_int >> 16) & 0xFF,
        "g": (color_int >> 8) & 0xFF,
        "b": color_int & 0xFF,
    }


def _looks_like_subset(basefont: str) -> bool:
    """PDF subset prefix convention: 6 uppercase letters + '+' + family.
    See PDF spec ISO 32000-2, §9.6.4 ("Font subsets")."""
    if "+" not in basefont:
        return False
    prefix = basefont.split("+", 1)[0]
    return len(prefix) == 6 and prefix.isalpha() and prefix.isupper()


def _ensure_font(fonts: dict[str, dict[str, Any]], basefont: str, xref: int = 0) -> str:
    if basefont in fonts:
        return fonts[basefont]["id"]

    is_subset = _looks_like_subset(basefont)
    family_full = basefont.split("+", 1)[-1] if is_subset else basefont

    weight = 400
    style = "normal"
    family = family_full

    for w_name, w_val in WEIGHT_NAMES.items():
        if w_name in family_full:
            weight = w_val
            family = family.replace("-" + w_name, "").replace(w_name, "")
            break

    if "Italic" in family_full:
        style = "italic"
        family = family.replace("-Italic", "").replace("Italic", "")
    elif "Oblique" in family_full:
        style = "oblique"
        family = family.replace("-Oblique", "").replace("Oblique", "")

    family = family.strip("- ").strip()

    font_id = f"font_{len(fonts):03d}"
    fonts[basefont] = {
        "id": font_id,
        "family": family,
        "weight": weight,
        "style": style,
        "source": "embedded" if is_subset else "system",
        "_meta": {"subset": is_subset, "original_basefont": basefont, "xref": xref},
    }
    return font_id


def _ensure_image(
    images: dict[int, dict[str, Any]],
    xref: int,
    doc: pymupdf.Document,
) -> str:
    if xref in images:
        return images[xref]["id"]

    info = doc.extract_image(xref)
    image_id = f"img_{len(images):03d}"
    images[xref] = {
        "id": image_id,
        "format": info["ext"],
        "width": info["width"],
        "height": info["height"],
        "data_ref": f"xref:{xref}",
    }
    return image_id
