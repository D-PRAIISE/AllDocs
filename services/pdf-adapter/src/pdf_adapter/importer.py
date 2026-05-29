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
import re
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


class EncryptedPdfError(Exception):
    """Raised when a PDF is encrypted and we can't open it without a
    password the user hasn't supplied. The web layer translates this
    into a structured error so the frontend can prompt for the
    password and retry."""

    def __init__(self, *, wrong_password: bool = False) -> None:
        super().__init__(
            "PDF is password-protected — wrong password"
            if wrong_password
            else "PDF is password-protected — password required"
        )
        self.wrong_password = wrong_password


def import_pdf(
    path: str | Path,
    assets_dir: str | Path | None = None,
    assets_url_prefix: str = "",
    source_url: str | None = None,
    enable_ocr: bool = True,
    ocr_lang: str | None = None,
    ocr_granularity: str = "line",
    password: str | None = None,
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
        # Encrypted PDFs come back from open() in a locked state —
        # iterating pages throws "document closed or encrypted". We
        # try the empty password first to cover the very common case
        # of "owner-only" encrypted PDFs (open without prompt in
        # Acrobat, restrict editing/printing). If that fails, try the
        # user-supplied password. If still locked, surface a structured
        # error so the web layer can prompt the user.
        if doc.needs_pass:
            authed = bool(doc.authenticate(""))
            if not authed and password:
                authed = bool(doc.authenticate(password))
            if not authed:
                raise EncryptedPdfError(wrong_password=bool(password))

        fonts: dict[str, dict[str, Any]] = {}
        images: dict[int, dict[str, Any]] = {}
        pages: list[dict[str, Any]] = []

        for page_idx, page in enumerate(doc):
            pages.append(_page_to_udm(page, page_idx + 1, fonts, images, doc))

        if enable_ocr:
            _apply_ocr(doc, pages, fonts, lang=ocr_lang, granularity=ocr_granularity)

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
    lang: str | None = None,
    granularity: str = "line",
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
            result = _ocr.ocr_page(page, lang=lang, granularity=granularity)
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

        # ToUnicode CMap preservation (lesson #13's deep fix). If the
        # source font dict references a /ToUnicode CMap, save its bytes
        # alongside the font file so the exporter's render path can
        # re-attach it. Without this a re-embedded CID/Type0 font loses
        # text-extractability and reads as ".notdef" boxes.
        try:
            cmap_bytes = _extract_tounicode_cmap(doc, xref)
        except Exception:
            cmap_bytes = None
        if cmap_bytes:
            cmap_filename = f"{font['id']}.tounicode.cmap"
            (fonts_dir / cmap_filename).write_bytes(cmap_bytes)
            font.setdefault("_meta", {})["tounicode_cmap"] = join(
                prefix, "fonts", cmap_filename
            )


def _page_to_udm(
    page: pymupdf.Page,
    number: int,
    fonts: dict[str, dict[str, Any]],
    images: dict[int, dict[str, Any]],
    doc: pymupdf.Document,
) -> dict[str, Any]:
    layers: list[dict[str, Any]] = []
    # Content-stream order map (lesson #11). get_bboxlog yields the
    # drawing operations in PDF content-stream order; we use the index
    # in that list as the layer's z-index when its bbox matches. Layers
    # that can't be matched fall back to the type-bucket sort in the
    # exporter.
    try:
        bboxlog = page.get_bboxlog()
    except Exception:
        bboxlog = []
    z_lookup = _ZIndexLookup(bboxlog)

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
    # Stamp a per-run z-index too: when text runs are emitted in
    # multiple paint passes, the exporter can sort runs individually.
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:  # 0 = text, 1 = image
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span.get("text"):
                    continue
                # Use the prefixed basefont if known so subset detection works.
                basefont, font_xref = span_to_font_info.get(span["font"], (span["font"], 0))
                bbox = span["bbox"]
                text_runs.append(
                    {
                        "text": span["text"],
                        "font_id": _ensure_font(fonts, basefont, font_xref),
                        "font_size": _length(span["size"], "pt"),
                        "color": {"literal": _color_int_to_value(span["color"])},
                        "x": _length(bbox[0], "pt"),
                        "y": _length(bbox[3], "pt"),
                    }
                )
    if text_runs:
        # NOTE: we used to stamp z_index = first-text-op here, but that
        # mis-orders every later text run when a shape paints between
        # text ops (e.g. a bank statement that draws background boxes
        # AFTER its header text and then more text on top of those
        # boxes — the shape would paint over the entire text layer
        # because we treated text as one big z=first batch).
        # The correct fix is per-run z + a paint-event interleave in
        # the exporter (v0.2). For now, leave text un-stamped; the
        # exporter's bucket-sort then paints text last, which matches
        # the common case (text on top of background shapes).
        layer: dict[str, Any] = {"type": "text", "runs": text_runs}
        layers.append(layer)

    for xref, rect, opacity, clip in _image_placements(page, doc):
        image_id = _ensure_image(images, xref, doc)
        layer = {
            "type": "image",
            "image_id": image_id,
            "x": _length(rect.x0, "pt"),
            "y": _length(rect.y0, "pt"),
            "width": _length(rect.width, "pt"),
            "height": _length(rect.height, "pt"),
        }
        meta: dict[str, Any] = {}
        if opacity < 1.0:
            layer["opacity"] = opacity
        # A clip path restricts what's visible. Without it the AllDocs
        # canvas re-renders the whole (often page-sized, off-page) image.
        if clip is not None:
            meta["clip"] = {
                "x": round(clip.x0, 2),
                "y": round(clip.y0, 2),
                "w": round(clip.width, 2),
                "h": round(clip.height, 2),
            }
        z = z_lookup.match(rect, kinds=("fill-image",))
        if z is not None:
            meta["z_index"] = z
        if meta:
            layer["_meta"] = meta
        layers.append(layer)

    # Vector drawings — backgrounds, dividers, lines, curves. Each gets
    # a z_index from get_bboxlog so layer ordering survives even when
    # a shape sits on top of text/images.
    for shape in _shape_layers_from_drawings(page):
        z = z_lookup.match_shape(shape)
        if z is not None:
            shape.setdefault("_meta", {})["z_index"] = z
        layers.append(shape)

    # AcroForm widgets — present on real fillable PDFs (registration forms,
    # tax forms, contracts). Each becomes a UDM form field that the editor
    # renders as a fillable input.
    form_fields = _form_fields_for(page)
    if form_fields:
        layers.append({"type": "form", "fields": form_fields})

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


_WIDGET_KIND = {
    "Text": "text",
    "CheckBox": "checkbox",
    "ListBox": "listbox",
    "ComboBox": "combobox",
    "RadioButton": "radio",
    "Signature": "signature",
}


def _form_fields_for(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Read AcroForm widgets on the page into UDM-friendly field dicts.

    ``_meta.xref`` is the widget xref so the exporter can update its
    value in place. ``_meta.type_str`` preserves the original PyMuPDF
    type string for unsupported kinds (radio/signature/etc.) so they
    survive a round-trip.

    If the page has no native widgets, fall back to heuristic detection
    (``_form_detect``) — visual-only forms (e.g. Word-exported PDFs with
    underlined blanks + checkbox squares) become fillable. Detected
    fields are marked ``_meta.auto_detected`` so the editor can flag
    them, and ``_meta.added`` so the exporter creates real widgets.
    """
    from . import _form_detect

    out: list[dict[str, Any]] = []
    try:
        widgets = list(page.widgets())
    except Exception:
        widgets = []

    for w in widgets:
        try:
            type_str = w.field_type_string or ""
            r = w.rect
            kind = _WIDGET_KIND.get(type_str, "unknown")
            meta: dict[str, Any] = {"xref": int(w.xref), "type_str": type_str}
            # Radios in the same group share field_name; each widget has
            # its own on-value (e.g. "Yes", "Option1", "Male") that the
            # exporter needs to know when the user selects this button.
            if kind == "radio":
                try:
                    states = w.button_states() or {}
                    normal = states.get("normal") or []
                    # The on-value is whichever state isn't "Off".
                    on_values = [str(s) for s in normal if str(s) != "Off"]
                    if on_values:
                        meta["on_value"] = on_values[0]
                except Exception:
                    pass
            field: dict[str, Any] = {
                "kind": kind,
                "name": w.field_name or "",
                "rect": {
                    "x": float(r.x0),
                    "y": float(r.y0),
                    "w": float(r.width),
                    "h": float(r.height),
                },
                "value": w.field_value,
                "_meta": meta,
            }
            out.append(field)
        except Exception:
            continue

    if not out and not _form_detect.page_reads_as_prose(page):
        candidates = _form_detect.detect_form_candidates(page)
        if len(candidates) >= _form_detect.MIN_CANDIDATES_TO_AUTOFILL:
            for c in candidates:
                r = c["rect"]
                out.append(
                    {
                        "kind": c["kind"],
                        "name": c.get("name") or "",
                        "rect": {
                            "x": float(r.x0),
                            "y": float(r.y0),
                            "w": float(r.width),
                            "h": float(r.height),
                        },
                        "value": False if c["kind"] == "checkbox" else "",
                        "_meta": {"added": True, "auto_detected": True},
                    }
                )

    return out


def _shape_layers_from_drawings(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Convert page.get_drawings() output into UDM ShapeLayers.

    Rectangles (``re``) keep their dedicated kind=rect geometry so the
    editor's shape-resize handles can target them directly.

    Every other path (line ``l``, cubic ``c``, partial-cubic ``v``/``y``,
    polygons, mixed) is captured as kind=path with an SVG-style ``d``
    string. The exporter walks the d-string and emits via
    page.draw_line / page.draw_bezier / etc. Lesson #12.
    """
    out: list[dict[str, Any]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return out

    # KNOWN LIMITATION (lesson #12 gradients): pure shading-pattern
    # fills (DeviceN /Pattern / Shading) don't appear in get_drawings()
    # at all — they show up only in get_bboxlog() as 'fill-shade' with
    # an Int32-range "all space" bbox. Properly capturing them needs
    # a clip-stack-aware content-stream interpreter that resolves the
    # `sh` operator under the current clip. That's its own focused
    # stretch; for now these shapes are lost on import (passthrough +
    # patch paths preserve them in the source PDF, so users only see
    # the gap on the rare full-rerender path). A non-fix because no
    # half-measure available with PyMuPDF alone yields correct results.
    for d in drawings:
        fill = d.get("fill")
        stroke = d.get("color")
        if fill is None and stroke is None:
            continue
        items = d.get("items") or []

        # Fast path: a single rect item with no other geometry. Keep as
        # kind=rect so resize handles + recolor still target it cleanly.
        if len(items) == 1 and items[0] and items[0][0] == "re":
            rect = items[0][1]
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
            _attach_shape_paint(layer, d, fill, stroke)
            out.append(layer)
            continue

        # Mixed / curved / line paths: emit an SVG d-string. We track the
        # current point so the relative-move semantics of "l/c/v/y" land
        # in absolute coords (PyMuPDF's items return absolute endpoints).
        d_parts: list[str] = []
        last: tuple[float, float] | None = None
        for item in items:
            if not item:
                continue
            op = item[0]
            try:
                if op == "re":
                    r = item[1]
                    x0, y0, w, h = float(r.x0), float(r.y0), float(r.width), float(r.height)
                    d_parts.append(f"M{x0:.3f},{y0:.3f} h{w:.3f} v{h:.3f} h{-w:.3f} Z")
                    last = (x0, y0)
                elif op == "l":
                    p1, p2 = item[1], item[2]
                    if last is None or last != (float(p1.x), float(p1.y)):
                        d_parts.append(f"M{float(p1.x):.3f},{float(p1.y):.3f}")
                    d_parts.append(f"L{float(p2.x):.3f},{float(p2.y):.3f}")
                    last = (float(p2.x), float(p2.y))
                elif op == "c":
                    # cubic: p1 (current), p2 (cp1), p3 (cp2), p4 (end)
                    p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
                    if last is None or last != (float(p1.x), float(p1.y)):
                        d_parts.append(f"M{float(p1.x):.3f},{float(p1.y):.3f}")
                    d_parts.append(
                        f"C{float(p2.x):.3f},{float(p2.y):.3f} "
                        f"{float(p3.x):.3f},{float(p3.y):.3f} "
                        f"{float(p4.x):.3f},{float(p4.y):.3f}"
                    )
                    last = (float(p4.x), float(p4.y))
                elif op in ("v", "y"):
                    # PDF partial-cubics: collapse to a regular cubic by
                    # duplicating one control point (PyMuPDF returns the
                    # absolute endpoints, so this is geometry-preserving).
                    p1, p2, p3 = item[1], item[2], item[3]
                    if last is None or last != (float(p1.x), float(p1.y)):
                        d_parts.append(f"M{float(p1.x):.3f},{float(p1.y):.3f}")
                    d_parts.append(
                        f"C{float(p2.x):.3f},{float(p2.y):.3f} "
                        f"{float(p2.x):.3f},{float(p2.y):.3f} "
                        f"{float(p3.x):.3f},{float(p3.y):.3f}"
                    )
                    last = (float(p3.x), float(p3.y))
            except (AttributeError, IndexError):
                continue

        if not d_parts:
            continue
        # Close if the drawing was closed (filled paths always are).
        if fill is not None and not d_parts[-1].endswith("Z"):
            d_parts.append("Z")

        layer = {
            "type": "shape",
            "geometry": {
                "kind": "path",
                "d": " ".join(d_parts),
            },
        }
        _attach_shape_paint(layer, d, fill, stroke)
        out.append(layer)
    return out


def _attach_shape_paint(
    layer: dict[str, Any],
    drawing: dict[str, Any],
    fill: Any,
    stroke: Any,
) -> None:
    if fill is not None:
        layer["fill"] = {
            "kind": "solid",
            "color": {"literal": _color_tuple_to_value(fill)},
        }
    stroke_width = float(drawing.get("width") or 0)
    if stroke is not None and stroke_width > 0:
        layer["stroke"] = {
            "paint": {
                "kind": "solid",
                "color": {"literal": _color_tuple_to_value(stroke)},
            },
            "width": _length(stroke_width, "pt"),
        }
    opacity = drawing.get("fill_opacity")
    if opacity is not None and 0 <= float(opacity) < 1:
        layer["opacity"] = float(opacity)


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


class _ZIndexLookup:
    """Map a layer's bbox + kind back to its position in get_bboxlog,
    which is the operation's z-index in the source content stream.

    Lesson #11: a single-pass type-bucket sort doesn't capture unusual
    layer orderings (image overlaying text, etc.). With per-layer
    z-indices stamped at import time, the exporter can replay the exact
    paint order.
    """

    def __init__(self, bboxlog: list[Any]) -> None:
        # bboxlog entry shape: (kind, bbox) where kind is e.g.
        # "fill-text" / "fill-image" / "stroke-rect" / etc.
        self._entries = list(enumerate(bboxlog))

    def first(self, kinds: tuple[str, ...]) -> int | None:
        """Return the z-index of the earliest entry whose kind is in
        ``kinds``. None if no match."""
        for idx, entry in self._entries:
            try:
                kind = entry[0]
            except (IndexError, TypeError):
                continue
            if kind in kinds:
                return idx
        return None

    def match(
        self,
        rect: Any,
        kinds: tuple[str, ...],
        tol: float = 1.5,
    ) -> int | None:
        """Find the bboxlog entry whose kind is in ``kinds`` and whose
        bbox is close to ``rect``. Returns its z-index or None.
        """
        try:
            rx0, ry0, rx1, ry1 = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
        except Exception:
            return None
        for idx, entry in self._entries:
            try:
                kind = entry[0]
                bb = entry[1]
                bx0, by0, bx1, by1 = float(bb.x0), float(bb.y0), float(bb.x1), float(bb.y1)
            except (IndexError, AttributeError, TypeError):
                continue
            if kind not in kinds:
                continue
            if (
                abs(bx0 - rx0) <= tol
                and abs(by0 - ry0) <= tol
                and abs(bx1 - rx1) <= tol
                and abs(by1 - ry1) <= tol
            ):
                return idx
        return None

    def match_shape(self, shape: dict[str, Any]) -> int | None:
        """Z-index for a captured shape — looks up the corresponding
        fill-/stroke-rect or fill-path entry by geometry."""
        geom = shape.get("geometry") or {}
        if geom.get("kind") == "rect":
            try:
                x = float(geom["x"]["value"])
                y = float(geom["y"]["value"])
                w = float(geom["w"]["value"])
                h = float(geom["h"]["value"])
            except (KeyError, TypeError, ValueError):
                return None
            class _Rect:
                pass
            r = _Rect()
            r.x0 = x
            r.y0 = y
            r.x1 = x + w
            r.y1 = y + h
            return self.match(r, kinds=("fill-rect", "stroke-rect", "fill-path", "stroke-path"))
        # kind=path — no clean bbox match without re-parsing the d
        # string. Skip for now; the exporter falls back to bucket sort.
        return None


def _extract_tounicode_cmap(doc: pymupdf.Document, font_xref: int) -> bytes | None:
    """Return the bytes of the /ToUnicode CMap stream referenced by a
    font dict, or None if it isn't present / can't be read.

    Type0 fonts hold ToUnicode at the top level. Some PDF producers
    place it on the DescendantFont instead — we check both. Identity-H
    encoded fonts almost always need this CMap for text extraction to
    work after re-embedding.
    """
    if not font_xref:
        return None
    seen: set[int] = set()

    def _follow(xref: int) -> int | None:
        if xref in seen:
            return None
        seen.add(xref)
        try:
            kind, val = doc.xref_get_key(xref, "ToUnicode")
        except Exception:
            return None
        if kind == "xref":
            # "N 0 R" -> extract N
            try:
                return int(str(val).split()[0])
            except (ValueError, IndexError):
                return None
        # No ToUnicode here — for Type0 fonts, descend into
        # DescendantFonts[0] and check there too.
        try:
            kind2, val2 = doc.xref_get_key(xref, "DescendantFonts")
        except Exception:
            return None
        if kind2 != "array":
            return None
        # val2 like "[ 9 0 R ]" — pull the first xref.
        m = re.search(r"(\d+)\s+0\s+R", str(val2))
        if not m:
            return None
        return _follow(int(m.group(1)))

    cmap_xref = _follow(font_xref)
    if not cmap_xref:
        return None
    try:
        data = doc.xref_stream(cmap_xref)
    except Exception:
        return None
    return data if data else None


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
