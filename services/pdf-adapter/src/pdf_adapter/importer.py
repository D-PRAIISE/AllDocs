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
    source_url: str | None = None,
    enable_ocr: bool = True,
) -> dict[str, Any]:
    """Read a PDF file and produce a UDM v0.1.0 document.

    If ``assets_dir`` is given, embedded images and fonts are extracted to
    that directory under ``images/`` and ``fonts/``. Resource ``data_ref``
    values in the returned UDM are rewritten as relative URLs of the form
    ``{assets_url_prefix}/images/<id>.<ext>`` (or ``images/<id>.<ext>`` if
    no prefix is given). When ``assets_dir`` is None, ``data_ref`` is left
    as the opaque ``xref:N`` form.

    If ``source_url`` is given, a passthrough block is attached to
    ``metadata.passthrough`` recording the URL and a content fingerprint.
    The exporter uses this to short-circuit re-rendering when the UDM
    hasn't been edited — see _passthrough.py.

    If ``enable_ocr`` is True (default), pages that are effectively flat
    images with no extractable text are OCR'd and the recognized lines
    are added as a TextLayer of runs marked with ``ocr``. Requires
    Tesseract; if it isn't installed, OCR is silently skipped.

    Returns a dict ready to be serialized as UDM JSON.
    """
    from . import _passthrough

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

        if enable_ocr:
            _apply_ocr(doc, pages, fonts)

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

        if source_url:
            _passthrough.attach(udm, source_url, sha256)

        return udm
    finally:
        doc.close()


def _apply_ocr(
    doc: pymupdf.Document,
    pages: list[dict[str, Any]],
    fonts: dict[str, dict[str, Any]],
) -> None:
    """Detect scanned/rasterized pages, OCR them, and append the
    recognized lines as a TextLayer of ``ocr``-marked runs.

    No-op (silently) if Tesseract isn't available — OCR is a best-effort
    enhancement, never a hard requirement for import.
    """
    from . import _ocr

    if not _ocr.tesseract_available():
        return

    ocr_font_id: str | None = None

    for page_idx, page in enumerate(doc):
        if page_idx >= len(pages):
            break
        if not _ocr.is_scanned_page(page):
            continue
        try:
            result = _ocr.ocr_page(page)
        except RuntimeError:
            continue
        if not result.runs:
            continue

        if ocr_font_id is None:
            ocr_font_id = f"font_{len(fonts):03d}"
            # Synthetic font for OCR'd text — there is no real embedded
            # font for recognized pixels. The exporter resolves this to a
            # bundled sans family; the editor renders it the same way.
            fonts["__ocr__"] = {
                "id": ocr_font_id,
                "family": "sans-serif",
                "weight": 400,
                "style": "normal",
                "source": "substituted",
                "_meta": {"ocr": True},
            }

        runs: list[dict[str, Any]] = []
        for r in result.runs:
            runs.append(
                {
                    "text": r.text,
                    "font_id": ocr_font_id,
                    "font_size": _length(r.font_size, "pt"),
                    "color": {
                        "literal": {
                            "kind": "rgb",
                            "r": r.color[0],
                            "g": r.color[1],
                            "b": r.color[2],
                        }
                    },
                    "x": _length(r.x0, "pt"),
                    "y": _length(r.y1, "pt"),
                    "ocr": {"confidence": r.confidence, "engine": result.engine},
                    # _meta carries OCR bookkeeping that doesn't fit the UDM
                    # PositionedTextRun schema (which only has baseline x/y):
                    #   ocr_width — line width in pt, for the editor overlay
                    #   ocr_text  — the originally recognized text, so the
                    #               exporter can tell which runs were edited
                    #   ocr_bg    — page background color, painted over the
                    #               old pixels when an OCR run is edited
                    "_meta": {
                        "ocr_width": round(r.x1 - r.x0, 2),
                        "ocr_text": r.text,
                        "ocr_bg": list(r.bg_color),
                    },
                }
            )
        pages[page_idx]["layers"].append({"type": "text", "runs": runs})


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

    for xref, rect, opacity, clip in _image_placements(page, doc):
        image_id = _ensure_image(images, xref, doc)
        layer: dict[str, Any] = {
            "type": "image",
            "image_id": image_id,
            "x": _length(rect.x0, "pt"),
            "y": _length(rect.y0, "pt"),
            "width": _length(rect.width, "pt"),
            "height": _length(rect.height, "pt"),
        }
        if opacity < 1.0:
            layer["opacity"] = opacity
        # A clip path restricts what's visible. Without it the AllDocs
        # canvas re-renders the whole (often page-sized, off-page) image.
        if clip is not None:
            layer["_meta"] = {
                "clip": {
                    "x": round(clip.x0, 2),
                    "y": round(clip.y0, 2),
                    "w": round(clip.width, 2),
                    "h": round(clip.height, 2),
                }
            }
        layers.append(layer)

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
        "rotation": int(page.rotation or 0),
        # source_page (0-based) lets the page-ops exporter rebuild a
        # reordered / deleted / rotated page set by copying the right
        # source page. Inserted blank pages have no source_page.
        "_meta": {"source_page": number - 1},
    }


def _image_placements(
    page: pymupdf.Page,
    doc: pymupdf.Document,
) -> list[tuple[int, pymupdf.Rect, float, pymupdf.Rect | None]]:
    """Return (xref, rect, opacity, clip) for every image placement.

    ``clip`` is the visible-window rectangle when the image is restricted
    by a clip path (None = unclipped). See _clip.py — without it a
    clipped, often page-sized image renders at full size on the canvas.

    ``page.get_image_rects`` only finds images placed directly in the
    page content stream. Images placed *through a Form XObject* — a
    very common pattern for watermarks and logos (the page does
    ``<matrix> cm /Form Do`` and the image lives inside the form) — are
    missed entirely.

    ``page.get_bboxlog`` does report every painted image including
    nested ones, but only as a bbox, with no xref. So: take the direct
    rects from ``get_image_rects``, then add any ``fill-image`` bbox
    from the bboxlog that isn't already one of them. A nested placement
    can be attributed to a specific image only when the page has a
    single image resource — which is the case for the watermark/logo
    pattern. Multi-image nested attribution is left for v0.2.

    Nested placements also pick up the page's minimum gs fill-alpha as
    their opacity — watermarks are drawn faint via an ExtGState ``ca``
    (e.g. ``.08``), and without that they'd render fully opaque.
    """
    from . import _clip

    xrefs = [img[0] for img in page.get_images(full=True)]
    placements: list[tuple[int, pymupdf.Rect, float, pymupdf.Rect | None]] = []
    direct: list[pymupdf.Rect] = []

    # Clip paths per image placement (xref + transform -> clip rect).
    try:
        clip_entries = _clip.extract_image_clips(page, doc)
    except Exception:
        clip_entries = []

    def clip_for(xref: int, rect: pymupdf.Rect) -> pymupdf.Rect | None:
        best: pymupdf.Rect | None = None
        best_d = 6.0  # match tolerance in points
        for e in clip_entries:
            if e.get("xref") != xref:
                continue
            t = e.get("transform")
            if t is None:
                continue
            d = abs(t.x0 - rect.x0) + abs(t.y0 - rect.y0) + abs(t.x1 - rect.x1) + abs(t.y1 - rect.y1)
            if d < best_d:
                best_d = d
                best = e.get("clip")
        if best is None:
            return None
        # Only report a clip that meaningfully restricts the image.
        if (
            abs(best.x0 - rect.x0) < 2
            and abs(best.y0 - rect.y0) < 2
            and abs(best.x1 - rect.x1) < 2
            and abs(best.y1 - rect.y1) < 2
        ):
            return None
        return best

    for xref in xrefs:
        for rect in page.get_image_rects(xref):
            placements.append((xref, rect, 1.0, clip_for(xref, rect)))
            direct.append(rect)

    try:
        bboxlog = page.get_bboxlog()
    except Exception:
        bboxlog = []

    nested: list[pymupdf.Rect] = []
    for kind, rect in bboxlog:
        if "image" not in kind.lower():
            continue
        r = pymupdf.Rect(rect)
        if r.is_empty or r.is_infinite:
            continue
        if any(_rects_close(r, d) for d in direct):
            continue
        if any(_rects_close(r, n) for n in nested):
            continue
        nested.append(r)

    if nested and len(xrefs) == 1:
        opacity = _page_min_gs_alpha(page, doc)
        for r in nested:
            placements.append((xrefs[0], r, opacity, clip_for(xrefs[0], r)))

    return placements


def _page_min_gs_alpha(page: pymupdf.Page, doc: pymupdf.Document) -> float:
    """Lowest fill-alpha (``ca``) of any ExtGState actually invoked via a
    ``gs`` operator in the page content. Returns 1.0 if none — i.e. the
    common case of opaque content.

    This is how the faint-watermark effect is encoded: the page defines
    an ExtGState like ``/gRLs0 <</ca .08>>`` and does ``/gRLs0 gs``
    before drawing the watermark image.
    """
    import re

    try:
        res = doc.xref_get_key(page.xref, "Resources")
        content = page.read_contents().decode("latin-1", "replace")
    except Exception:
        return 1.0

    res_str = res[1] if isinstance(res, tuple) and len(res) > 1 else ""
    if not res_str:
        return 1.0

    # ExtGState entry -> ca value, e.g. /gRLs0<</ca .08>>. The [^<>]
    # class is deliberate: it stops the match from crossing into a
    # nested dict, so the captured name is the gs entry, not /ExtGState.
    name_to_ca: dict[str, float] = {}
    for m in re.finditer(r"/([A-Za-z0-9]+)\s*<<[^<>]*?/ca\s+([0-9.]+)", res_str):
        try:
            name_to_ca[m.group(1)] = float(m.group(2))
        except ValueError:
            continue
    if not name_to_ca:
        return 1.0

    invoked = set(re.findall(r"/([A-Za-z0-9]+)\s+gs\b", content))
    alphas = [name_to_ca[n] for n in invoked if n in name_to_ca]
    if not alphas:
        return 1.0
    return max(0.0, min(1.0, min(alphas)))


def _rects_close(a: pymupdf.Rect, b: pymupdf.Rect, tol: float = 1.0) -> bool:
    return (
        abs(a.x0 - b.x0) <= tol
        and abs(a.y0 - b.y0) <= tol
        and abs(a.x1 - b.x1) <= tol
        and abs(a.y1 - b.y1) <= tol
    )


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
        # Source PDF image XObject xref. The patch exporter needs it to
        # replace this image in place when the user swaps it in the editor.
        "_meta": {"xref": xref},
    }
    return image_id
