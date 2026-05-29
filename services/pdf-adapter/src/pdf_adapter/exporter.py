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

Passthrough (Approach C, lesson #14):
  When the UDM still matches the fingerprint recorded at import time AND
  the original source PDF is reachable, we copy the source bytes
  verbatim to the output and skip rendering entirely. This is the only
  way to guarantee byte-identical round-trip — the v0.1 render path
  unavoidably loses font fidelity, vector precision, annotations, and
  embedded resources we don't yet model in UDM.

Lessons applied (memory/project_alldocs_pdf_adapter.md):
  #1 (subset fonts): fall back to base-14 when no usable font file exists
  #3 (off-page placements): preserved verbatim — Length values copied through
  #4 (multi-placement images): each ImageLayer is independent; resource is
     loaded once but inserted at each placement
  #14 (passthrough): byte-identical emit when fingerprint matches.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pymupdf

from . import _passthrough, patch_export

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
    password: str | None = None,
) -> None:
    """Render a UDM document to a PDF file at ``output_path``.

    ``base_dir`` is used to resolve relative ``data_ref`` URLs in
    ``udm.resources``. It defaults to the current working directory.

    ``password``: if given, the output PDF is encrypted with AES-256
    using this string as both the owner and user password. The
    passthrough path is skipped (a byte-identical copy can't be
    re-encrypted); patch and render paths both encrypt at save time.
    Pass None (default) to write the PDF unprotected, regardless of
    whether the source had a password.
    """
    if udm.get("mode") == "flow":
        # Cross-format: flow UDM (e.g. imported DOCX) -> paginated fixed UDM.
        from .flow_to_fixed import flow_to_fixed

        udm = flow_to_fixed(udm)
    elif udm.get("mode") != "fixed":
        raise NotImplementedError(
            f"PDF export supports flow and fixed UDM; got mode={udm.get('mode')!r}"
        )

    base = Path(base_dir) if base_dir else Path.cwd()

    # Passthrough is a byte-identical copy — we can't apply or strip
    # encryption without re-saving. Skip it whenever the caller asked
    # for a specific password (set or remove) so the user always gets
    # the encryption state they asked for.
    if password is None and _try_passthrough(udm, output_path, base):
        return

    # Patch-based export: when the UDM differs from the source only by
    # text-content edits to existing runs, apply them via redact+insert
    # against the source PDF instead of re-rendering from scratch. This
    # preserves font fidelity, vector precision, annotations, AcroForms,
    # and every other resource we don't yet model in UDM. See patch_export.py
    # and project_alldocs_pdf_adapter.md lesson #14.
    if patch_export.try_patch_export(udm, output_path, base, password=password):
        return

    doc = pymupdf.open()
    try:
        font_handles = _resolve_fonts(udm["resources"]["fonts"], base)
        tounicode_cmaps = _load_tounicode_cmaps(udm["resources"]["fonts"], base)
        # Track (page_num, font_id) pairs we've already attached so we
        # only run the xref injection once per font per page.
        attached_tounicode: set[tuple[int, str]] = set()

        for page_data in udm["content"]["pages"]:
            _render_page(
                doc,
                page_data,
                udm["resources"],
                font_handles,
                base,
                tounicode_cmaps=tounicode_cmaps,
                attached_tounicode=attached_tounicode,
            )

        _apply_metadata(doc, udm.get("metadata", {}))
        _save_with_optional_password(doc, output_path, password)
    finally:
        doc.close()


def _save_with_optional_password(
    doc: pymupdf.Document,
    output_path: str | Path,
    password: str | None,
) -> None:
    """Wrap doc.save with encryption args when a password is supplied.
    Centralised so patch_export and the render path emit identical
    on-disk encryption settings."""
    common_kwargs: dict[str, Any] = {"garbage": 4, "deflate": True, "clean": True}
    if password:
        common_kwargs["encryption"] = pymupdf.PDF_ENCRYPT_AES_256
        common_kwargs["owner_pw"] = password
        common_kwargs["user_pw"] = password
    doc.save(str(output_path), **common_kwargs)


def _load_tounicode_cmaps(
    fonts: list[dict[str, Any]],
    base: Path,
) -> dict[str, bytes]:
    """Read saved /ToUnicode CMap files for each font that has one
    (importer stashes the path under font._meta.tounicode_cmap). Used
    by the render path to re-attach the CMap so a re-embedded CIDFont
    stays text-extractable. Lesson #13.
    """
    out: dict[str, bytes] = {}
    for font in fonts:
        ref = (font.get("_meta") or {}).get("tounicode_cmap")
        if not ref:
            continue
        try:
            path = _resolve_relative(base, str(ref))
            if path.exists():
                out[font["id"]] = path.read_bytes()
        except Exception:
            continue
    return out


def _try_passthrough(
    udm: dict[str, Any],
    output_path: str | Path,
    base: Path,
) -> bool:
    """If the UDM still matches its import-time fingerprint AND the
    original source bytes are reachable, copy them verbatim to
    ``output_path`` and return True. Otherwise return False — caller
    falls through to the render path.
    """
    pt = _passthrough.can_passthrough(udm)
    if pt is None:
        return False

    source_url: str = pt["source_url"]
    source_path = _resolve_relative(base, source_url)
    if not source_path.exists():
        return False

    shutil.copyfile(str(source_path), str(output_path))
    return True


# ---- Fonts ---------------------------------------------------------------

# Each font_id maps to either:
#   ("file", absolute_path_to_ttf_or_otf)  — embed via fontfile=
#   ("base14", pdf_short_name)             — use a built-in PDF font
FontHandle = tuple[str, str]


def _resolve_fonts(
    fonts: list[dict[str, Any]],
    base: Path,
) -> dict[str, FontHandle]:
    """Three-tier font resolution:

      1. The font extracted from the source PDF, if it has a usable
         Unicode cmap (probed via has_glyph on a Latin sample).
      2. A bundled metric-compatible fallback (Arimo/Tinos/Cousine).
         These are *much* closer to the original visual metrics than
         the base-14 stock fonts because they were designed to be
         metric-equivalent with Arial/Times/Courier.
      3. PDF base-14 stock font (Helvetica/Times/Courier).

    See PDF-adapter lesson #13.
    """
    from ._fonts import resolve_fallback

    handles: dict[str, FontHandle] = {}
    for font in fonts:
        font_id = font["id"]

        # Tier 1: try the extracted subset.
        data_ref = font.get("data_ref")
        if data_ref and not data_ref.startswith(("http://", "https://", "xref:")):
            font_path = _resolve_relative(base, data_ref)
            if font_path.exists() and _font_usable_for_unicode(font_path):
                handles[font_id] = ("file", str(font_path))
                continue

        # Tier 2: try the bundled metric-compatible family.
        bundled = resolve_fallback(font.get("family", ""), font.get("weight", 400), font.get("style", "normal"))
        if bundled is not None and _font_usable_for_unicode(bundled):
            handles[font_id] = ("file", str(bundled))
            continue

        # Tier 3: PDF base-14 stock font.
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


# Paint order (lower = drawn first = at the back). Mirrors
# web/components/FixedEditorCanvas.tsx LAYER_PAINT_ORDER.
# Shapes split into "bg" (page-spanning panels, header bars) and "fg"
# (table cell backgrounds, accent strips). Real PDFs often put images on
# top of bg shapes (e.g., a logo on a colored header) and text on top of
# fg shapes (e.g., labels in a table cell). A single shape bucket
# can't honor both — the bg/fg split is the heuristic that handles
# the common cases. Proper fix in v0.2 is content-stream order at
# import time (see lesson #11).
_LAYER_ORDER_BG_SHAPE = 0
_LAYER_ORDER_IMAGE = 1
_LAYER_ORDER_FG_SHAPE = 2
_LAYER_ORDER_ANNOTATION = 3
_LAYER_ORDER_TEXT = 4
_LAYER_ORDER_FORM = 5


def _shape_is_background(layer: dict[str, Any], page_width_pt: float, page_height_pt: float) -> bool:
    geom = layer.get("geometry") or {}
    if geom.get("kind") != "rect":
        return False
    try:
        w = float(geom["w"]["value"])
        h = float(geom["h"]["value"])
    except (KeyError, TypeError, ValueError):
        return False
    if page_width_pt <= 0 or page_height_pt <= 0:
        return False
    spans_width = w / page_width_pt >= 0.9
    spans_height = h / page_height_pt >= 0.9
    big_area = (w * h) / (page_width_pt * page_height_pt) >= 0.2
    return spans_width or spans_height or big_area


def _layer_order_key(layer: dict[str, Any], page_width_pt: float, page_height_pt: float) -> int:
    t = layer.get("type", "")
    if t == "shape":
        return _LAYER_ORDER_BG_SHAPE if _shape_is_background(layer, page_width_pt, page_height_pt) else _LAYER_ORDER_FG_SHAPE
    return {
        "image": _LAYER_ORDER_IMAGE,
        "annotation": _LAYER_ORDER_ANNOTATION,
        "text": _LAYER_ORDER_TEXT,
        "form": _LAYER_ORDER_FORM,
    }.get(t, 99)


def _render_page(
    doc: pymupdf.Document,
    page_data: dict[str, Any],
    resources: dict[str, Any],
    font_handles: dict[str, FontHandle],
    base: Path,
    tounicode_cmaps: dict[str, bytes] | None = None,
    attached_tounicode: set[tuple[int, str]] | None = None,
) -> None:
    width_pt = _length_to_pt(page_data["width"])
    height_pt = _length_to_pt(page_data["height"])
    page = doc.new_page(width=width_pt, height=height_pt)

    # Sort layers by paint order. The importer now stamps _meta.z_index
    # from page.get_bboxlog() (lesson #11) — when present that's the real
    # content-stream position. Layers without a stamped z-index fall
    # back to the older type-bucket heuristic (added content, form
    # layers, OCR runs, etc., don't come from get_bboxlog).
    def _key(layer: dict[str, Any]) -> tuple[int, int]:
        meta = layer.get("_meta") or {}
        z = meta.get("z_index")
        bucket = _layer_order_key(layer, width_pt, height_pt)
        # Primary sort: z_index if available; fall back to a synthetic
        # large index so unstamped layers paint after the stamped ones
        # in the order they appear in the UDM (Python sort is stable).
        if isinstance(z, int):
            return (0, z)
        return (1, bucket)

    layers = sorted(page_data.get("layers", []), key=_key)
    for layer in layers:
        kind = layer.get("type")
        if kind == "text":
            _render_text_layer(
                page,
                layer,
                font_handles,
                tounicode_cmaps=tounicode_cmaps,
                attached_tounicode=attached_tounicode,
            )
        elif kind == "image":
            _render_image_layer(page, layer, resources, base)
        elif kind == "shape":
            _render_shape_layer(page, layer)
        # annotation / form: v0.2


def _render_text_layer(
    page: pymupdf.Page,
    layer: dict[str, Any],
    font_handles: dict[str, FontHandle],
    tounicode_cmaps: dict[str, bytes] | None = None,
    attached_tounicode: set[tuple[int, str]] | None = None,
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
            # Lesson #13 "real fix": after PyMuPDF embeds the font on
            # this page, attach the saved ToUnicode CMap so re-embedded
            # CIDFonts stay text-extractable. Once per (page, font_id).
            if tounicode_cmaps and attached_tounicode is not None:
                cmap_bytes = tounicode_cmaps.get(font_id)
                if cmap_bytes:
                    page_num = page.number
                    key = (page_num, font_id)
                    if key not in attached_tounicode:
                        if _attach_tounicode_to_font(page, font_id, cmap_bytes):
                            attached_tounicode.add(key)
        else:
            page.insert_text(
                (x, y),
                text,
                fontsize=size,
                color=color,
                fontname=value,
            )


def _attach_tounicode_to_font(
    page: pymupdf.Page,
    font_id: str,
    cmap_bytes: bytes,
) -> bool:
    """Find the just-inserted font on this page by its udm_<font_id>
    name and add a /ToUnicode entry pointing at a fresh stream xref
    holding ``cmap_bytes``. Returns True on success.

    Without ToUnicode, re-embedded CIDFonts (Identity-H encoding) read
    as .notdef boxes when copy-pasted from the output PDF.
    """
    doc = page.parent
    target_name = f"udm_{font_id}"
    try:
        fonts = doc.get_page_fonts(page.number, full=True)
    except Exception:
        return False
    font_xref = 0
    for entry in fonts:
        # entry layout: (xref, ext, type, basefont, refname, encoding, ...)
        try:
            xref = entry[0]
            basefont = entry[3] if len(entry) > 3 else ""
            refname = entry[4] if len(entry) > 4 else ""
        except (IndexError, TypeError):
            continue
        if target_name in str(basefont) or target_name in str(refname):
            font_xref = int(xref)
            break
    if not font_xref:
        return False
    try:
        cmap_xref = doc.get_new_xref()
        # Mark as a CMap stream — the /Type and /CMapName aren't strictly
        # required for ToUnicode CMaps but help validators / debuggers.
        doc.update_object(
            cmap_xref,
            "<< /Type /CMap /CMapName /Adobe-Identity-UCS /Length 0 >>",
        )
        doc.update_stream(cmap_xref, cmap_bytes)
        doc.xref_set_key(font_xref, "ToUnicode", f"{cmap_xref} 0 R")
    except Exception:
        return False
    return True


def _render_shape_layer(page: pymupdf.Page, layer: dict[str, Any]) -> None:
    """Render a shape layer.

    kind=rect    → page.draw_rect (fastest path; preserves resize semantics)
    kind=path    → walk the SVG-style ``d`` string and emit a single shape
                   via PyMuPDF's Shape API (page.new_shape).
    Gradients / patterns land in v0.2.
    """
    geom = layer.get("geometry") or {}
    kind = geom.get("kind")

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

    if kind == "rect":
        rect = pymupdf.Rect(
            _length_to_pt(geom["x"]),
            _length_to_pt(geom["y"]),
            _length_to_pt(geom["x"]) + _length_to_pt(geom["w"]),
            _length_to_pt(geom["y"]) + _length_to_pt(geom["h"]),
        )
        page.draw_rect(
            rect,
            color=stroke_color,
            fill=fill_color,
            width=stroke_width,
            fill_opacity=float(layer.get("opacity", 1)),
        )
        return

    if kind == "path":
        d = str(geom.get("d") or "")
        if not d:
            return
        _draw_svg_path(
            page,
            d,
            fill_color=fill_color,
            stroke_color=stroke_color,
            stroke_width=stroke_width,
            opacity=float(layer.get("opacity", 1)),
        )


def _draw_svg_path(
    page: pymupdf.Page,
    d: str,
    fill_color: tuple[float, float, float] | None,
    stroke_color: tuple[float, float, float] | None,
    stroke_width: float,
    opacity: float,
) -> None:
    """Walk a tiny subset of SVG path syntax (M/L/H/V/C/Z; uppercase
    absolute + lowercase relative) and replay it via PyMuPDF's Shape
    API. The d-strings we emit on import are a strict subset of this,
    so we only need to recognise what we produce."""
    import re

    shape = page.new_shape()
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    # Tokenise: each command letter + the numbers after it.
    cmd_re = re.compile(r"([MmLlHhVvCcZz])([^MmLlHhVvCcZz]*)")
    num_re = re.compile(r"-?\d+(?:\.\d+)?")
    for match in cmd_re.finditer(d):
        cmd = match.group(1)
        args = [float(n) for n in num_re.findall(match.group(2) or "")]
        rel = cmd.islower()
        try:
            if cmd in ("M", "m"):
                # First pair = move; subsequent pairs = implicit lineTo.
                i = 0
                first = True
                while i + 1 < len(args):
                    x, y = args[i], args[i + 1]
                    if rel:
                        x, y = cur[0] + x, cur[1] + y
                    if first:
                        cur = (x, y)
                        start = cur
                        first = False
                    else:
                        shape.draw_line(pymupdf.Point(*cur), pymupdf.Point(x, y))
                        cur = (x, y)
                    i += 2
            elif cmd in ("L", "l"):
                i = 0
                while i + 1 < len(args):
                    x, y = args[i], args[i + 1]
                    if rel:
                        x, y = cur[0] + x, cur[1] + y
                    shape.draw_line(pymupdf.Point(*cur), pymupdf.Point(x, y))
                    cur = (x, y)
                    i += 2
            elif cmd in ("H", "h"):
                for v in args:
                    x = cur[0] + v if rel else v
                    shape.draw_line(pymupdf.Point(*cur), pymupdf.Point(x, cur[1]))
                    cur = (x, cur[1])
            elif cmd in ("V", "v"):
                for v in args:
                    y = cur[1] + v if rel else v
                    shape.draw_line(pymupdf.Point(*cur), pymupdf.Point(cur[0], y))
                    cur = (cur[0], y)
            elif cmd in ("C", "c"):
                i = 0
                while i + 5 < len(args):
                    cp1 = (args[i], args[i + 1])
                    cp2 = (args[i + 2], args[i + 3])
                    end = (args[i + 4], args[i + 5])
                    if rel:
                        cp1 = (cur[0] + cp1[0], cur[1] + cp1[1])
                        cp2 = (cur[0] + cp2[0], cur[1] + cp2[1])
                        end = (cur[0] + end[0], cur[1] + end[1])
                    shape.draw_bezier(
                        pymupdf.Point(*cur),
                        pymupdf.Point(*cp1),
                        pymupdf.Point(*cp2),
                        pymupdf.Point(*end),
                    )
                    cur = end
                    i += 6
            elif cmd in ("Z", "z"):
                if cur != start:
                    shape.draw_line(pymupdf.Point(*cur), pymupdf.Point(*start))
                    cur = start
        except Exception:
            # One malformed segment shouldn't kill the whole shape.
            continue

    shape.finish(
        color=stroke_color,
        fill=fill_color,
        width=stroke_width,
        closePath=False,
        fill_opacity=opacity,
        stroke_opacity=opacity,
    )
    shape.commit()


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
    # KNOWN LIMITATION (lesson #16): PyMuPDF's insert_image has no
    # opacity / alpha parameter. Its `alpha` argument is an
    # alpha-channel flag (PNG transparency), not an opacity multiplier.
    # When this full-render path runs on a doc whose images had a
    # Form-XObject `ca` alpha (faint watermarks/logos), the image
    # paints fully opaque. The passthrough + patch paths preserve the
    # original faint rendering — only this fallback path is affected.
    # A proper fix needs a different PDF library (pikepdf) or a
    # post-render content-stream rewrite, both out of scope for now.
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
