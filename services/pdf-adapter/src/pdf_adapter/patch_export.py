"""
Patch-based PDF export.

Instead of throwing away the source PDF and re-rendering everything from
UDM (which loses font fidelity, vector precision, annotations, AcroForms,
ICC profiles, and anything else v0.1 doesn't model), we open the source
PDF and apply only the patches that correspond to UDM edits. The export
preserves byte-identical output for every unedited region.

The pattern is the one proven in edit_cv.py (the manual Kara's CV edit
that predates AllDocs):

  for each edited text run:
      page.add_redact_annot(rect, fill=None)
      page.apply_redactions(images=PDF_REDACT_IMAGE_NONE)
      page.insert_text(baseline, new_text, fontfile=..., color=...)

Font handling tracks lesson #1: an extracted subset font usually doesn't
have glyphs for new characters (the famous "Cook" -> "Waiter" missing W).
We probe has_glyph on the extracted subset; if it covers the new text we
use it (highest fidelity — same font as the surrounding text), otherwise
we fall back to a bundled metric-compatible full font (Arimo / Tinos /
Cousine — see _fonts.py).

Scope (v1):
  - Text content edits on existing positioned runs (PositionedTextRun.text changed)
  - Position, font, size, color edits are NOT yet handled — only the text string
  - Image / shape edits are NOT handled — caller falls back to full re-render
  - Single-line runs only (multi-line via newlines in run.text not supported in v1)
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

import pymupdf

from ._fonts import resolve_fallback

# Position match tolerance (PDF points). PyMuPDF text extraction round-trips
# through float, and we compare run.x/y from the importer (which copies
# span.bbox.x0/y1) against source spans on the live PDF. They should be
# exact-equal but a small tolerance is harmless and protects against
# refactors that introduce rounding.
_POSITION_TOL = 1.5


def try_patch_export(
    udm: dict[str, Any],
    output_path: str | Path,
    base_dir: Path,
) -> bool:
    """Try to render the UDM by patching the source PDF.

    Returns True if the export succeeded (output_path written). Returns
    False if patching is not applicable — the caller should fall through
    to the full re-render path. Reasons we return False:

      - No metadata.passthrough block (UDM wasn't imported with passthrough)
      - Source PDF unreachable on disk
      - Diff is empty (no detected text edits — likely image/shape edits
        we can't handle yet)
      - Diff contains a change we can't patch (e.g., new text run added,
        existing run deleted)
    """
    passthrough = (udm.get("metadata") or {}).get("passthrough") or {}
    source_url = passthrough.get("source_url")
    if not source_url:
        return False

    source_path = _resolve_relative(base_dir, source_url)
    if not source_path.exists():
        return False

    doc = pymupdf.open(str(source_path))
    try:
        # Image swaps are orthogonal to text edits — a UDM image resource
        # whose data_ref became a data: URL means the user replaced it.
        image_swaps = _diff_image_resources(udm)

        # OCR docs (scanned / rasterized — text sits over an image) take a
        # separate path: there are no source text spans to redact, so we
        # cover the old pixels and draw the new text on top.
        if _udm_has_ocr_runs(udm):
            ocr_edits = _diff_ocr_runs(udm)
            if not ocr_edits and not image_swaps:
                return False
            for page_idx, page_edits in ocr_edits.items():
                if page_idx >= len(doc):
                    continue
                page = doc[page_idx]
                for e in page_edits:
                    page.draw_rect(e["cover_rect"], color=None, fill=e["bg_color"])
                    _insert_replacement(page, e, udm, base_dir)
            _apply_image_swaps(doc, image_swaps)
            doc.save(str(output_path), garbage=4, deflate=True, clean=True)
            return True

        edits_by_page, fully_patchable = _diff_runs(udm, doc)
        if not fully_patchable:
            return False
        if not edits_by_page and not image_swaps:
            # No edits to apply but fingerprint differs (otherwise passthrough
            # would have fired). Treat as fall-through to render.
            return False

        # Apply: queue all redacts on a page, apply them once, then insert
        # all new text. Doing inserts after apply_redactions avoids the
        # new text getting erased.
        for page_idx, page_edits in edits_by_page.items():
            page = doc[page_idx]
            for e in page_edits:
                page.add_redact_annot(e["rect"], fill=None)
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
            for e in page_edits:
                _insert_replacement(page, e, udm, base_dir)

        _apply_image_swaps(doc, image_swaps)
        doc.save(str(output_path), garbage=4, deflate=True, clean=True)
        return True
    finally:
        doc.close()


def _udm_has_ocr_runs(udm: dict[str, Any]) -> bool:
    for page in udm.get("content", {}).get("pages", []) or []:
        for layer in page.get("layers", []):
            if layer.get("type") != "text":
                continue
            for run in layer.get("runs", []):
                if run.get("ocr"):
                    return True
    return False


def _diff_image_resources(udm: dict[str, Any]) -> list[tuple[int, bytes]]:
    """Find image resources the user replaced in the editor.

    A replaced image has a ``data:`` URL as its ``data_ref`` (the editor
    reads the picked file as a data URL). Its ``_meta.xref`` is the
    source PDF image XObject to overwrite. Returns (xref, image_bytes).
    """
    import base64

    swaps: list[tuple[int, bytes]] = []
    for img in (udm.get("resources") or {}).get("images", []) or []:
        data_ref = str(img.get("data_ref") or "")
        if not data_ref.startswith("data:"):
            continue
        xref = (img.get("_meta") or {}).get("xref")
        if not xref:
            continue
        comma = data_ref.find(",")
        if comma < 0:
            continue
        try:
            raw = base64.b64decode(data_ref[comma + 1 :])
        except Exception:
            continue
        if raw:
            swaps.append((int(xref), raw))
    return swaps


def _apply_image_swaps(doc: pymupdf.Document, swaps: list[tuple[int, bytes]]) -> None:
    """Overwrite source image XObjects in place. Every placement of the
    xref (e.g. a logo used on multiple pages) updates at once — which is
    the desired behavior for a resource-level swap."""
    for xref, raw in swaps:
        try:
            page = _page_using_xref(doc, xref)
            page.replace_image(xref, stream=raw)
        except Exception:
            # A bad xref or unsupported image — skip rather than abort the
            # whole export; other patches still apply.
            continue


def _page_using_xref(doc: pymupdf.Document, xref: int) -> pymupdf.Page:
    """Return a page that references ``xref`` as an image (replace_image
    is a Page method). Falls back to page 0."""
    for page in doc:
        for img in page.get_images(full=True):
            if img[0] == xref:
                return page
    return doc[0]


def _diff_ocr_runs(udm: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """Find OCR runs whose text differs from what was originally
    recognized (``_meta.ocr_text``). Returns patch metadata per page."""
    from collections import defaultdict

    edits: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pages = udm.get("content", {}).get("pages") or []

    for page_idx, page in enumerate(pages):
        for layer in page.get("layers", []):
            if layer.get("type") != "text":
                continue
            for run in layer.get("runs", []):
                if not run.get("ocr"):
                    continue
                meta = run.get("_meta") or {}
                original = meta.get("ocr_text")
                current = run.get("text", "")
                if original is None or original == current:
                    continue  # unedited

                x = float(run["x"]["value"])
                y = float(run["y"]["value"])  # baseline (line bottom)
                fs = float(run["font_size"]["value"])
                width = float(meta.get("ocr_width") or (len(current) * fs * 0.5))
                bg = meta.get("ocr_bg") or [255, 255, 255]

                # Pad the cover rect so anti-aliased glyph edges of the old
                # text are fully hidden. Extend right far enough to also
                # cover a longer replacement string.
                pad = fs * 0.18
                est_new_width = len(current) * fs * 0.55
                cover_w = max(width, est_new_width) + pad * 2
                cover_rect = pymupdf.Rect(
                    x - pad,
                    y - fs - pad,
                    x - pad + cover_w,
                    y + pad,
                )

                edits[page_idx].append(
                    {
                        "cover_rect": cover_rect,
                        "bg_color": (bg[0] / 255.0, bg[1] / 255.0, bg[2] / 255.0),
                        "new_text": current,
                        "baseline": (x, y),
                        "font_size": fs,
                        "color": run.get("color") or {},
                        "font_id": run.get("font_id"),
                    }
                )

    return dict(edits)


def _diff_runs(
    udm: dict[str, Any],
    source_doc: pymupdf.Document,
) -> tuple[dict[int, list[dict[str, Any]]], bool]:
    """Compute the diff between UDM text runs and the source PDF's spans.

    Returns (edits_by_page, fully_patchable). ``fully_patchable`` is False
    if we detect a change we can't apply via redact+insert (added run,
    deleted run, mode change, etc.) — caller falls back to render.
    """
    edits_by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)

    if udm.get("mode") != "fixed":
        return {}, False

    udm_pages = udm.get("content", {}).get("pages") or []
    if len(udm_pages) != len(source_doc):
        # Pages added/removed — can't patch.
        return {}, False

    for page_idx, udm_page in enumerate(udm_pages):
        src_page = source_doc[page_idx]
        src_spans = _collect_spans(src_page)
        used_spans: set[int] = set()

        for layer in udm_page.get("layers", []):
            if layer.get("type") != "text":
                continue
            for run in layer.get("runs", []):
                udm_text = run.get("text", "")
                udm_x = float(run["x"]["value"])
                udm_y = float(run["y"]["value"])

                match_idx = _find_span(src_spans, udm_x, udm_y, used_spans)
                if match_idx is None:
                    # UDM has a run that doesn't exist in source — caller can't
                    # patch (new text addition isn't supported in v1).
                    return {}, False
                used_spans.add(match_idx)
                src_span = src_spans[match_idx]

                if src_span["text"] == udm_text:
                    continue  # No change to this run

                bbox = src_span["bbox"]
                edits_by_page[page_idx].append(
                    {
                        "rect": pymupdf.Rect(*bbox),
                        "baseline": (float(bbox[0]), float(bbox[3])),
                        "new_text": udm_text,
                        "old_text": src_span["text"],
                        "font_id": run.get("font_id"),
                        "font_size": float(run["font_size"]["value"]),
                        "color": run.get("color") or {},
                    }
                )

        # If any source span on this page wasn't matched, it means UDM
        # deleted a run we can't reproduce — caller falls back.
        if len(used_spans) != len(src_spans):
            return {}, False

    return dict(edits_by_page), True


def _collect_spans(page: pymupdf.Page) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("text"):
                    spans.append(span)
    return spans


def _find_span(
    spans: list[dict[str, Any]],
    x: float,
    y: float,
    used: set[int],
) -> int | None:
    for idx, span in enumerate(spans):
        if idx in used:
            continue
        bx0 = float(span["bbox"][0])
        by1 = float(span["bbox"][3])
        if abs(bx0 - x) <= _POSITION_TOL and abs(by1 - y) <= _POSITION_TOL:
            return idx
    return None


def _insert_replacement(
    page: pymupdf.Page,
    edit: dict[str, Any],
    udm: dict[str, Any],
    base_dir: Path,
) -> None:
    """Insert the replacement text after a redact has cleared the original."""
    font_resource = _font_by_id(udm, edit.get("font_id"))
    new_text: str = edit["new_text"]
    fontfile = _pick_font_for_text(font_resource, new_text, base_dir)
    color = _color_rgb01(edit["color"])
    x, y = edit["baseline"]
    size = edit["font_size"]

    if fontfile is not None:
        # Register the font under a stable name and use it.
        fontname = f"udm_patch_{edit.get('font_id') or 'unknown'}"
        try:
            page.insert_font(fontname=fontname, fontfile=str(fontfile))
        except Exception:
            # If insert_font fails (corrupt font, etc.), fall back to base-14.
            fontfile = None

    if fontfile is not None:
        page.insert_text(
            (x, y),
            new_text,
            fontsize=size,
            color=color,
            fontname=f"udm_patch_{edit.get('font_id') or 'unknown'}",
        )
    else:
        page.insert_text(
            (x, y),
            new_text,
            fontsize=size,
            color=color,
            fontname=_base14_for(font_resource),
        )


def _pick_font_for_text(
    font_resource: dict[str, Any] | None,
    text: str,
    base_dir: Path,
) -> Path | None:
    """Pick the highest-fidelity font file able to render ``text``.

    Order:
      1. The extracted subset from the source PDF, if it has all the
         Unicode codepoints in ``text``. (Highest fidelity — exact same
         font as the surrounding unedited text.)
      2. A bundled metric-compatible Apache-2 font of the same family
         classification (sans/serif/mono).
      3. None — caller uses a PDF base-14 stock font.
    """
    if font_resource is None:
        return resolve_fallback("", 400, "normal")

    # Tier 1: extracted subset
    data_ref = font_resource.get("data_ref")
    if data_ref and not str(data_ref).startswith(("http://", "https://", "xref:")):
        candidate = _resolve_relative(base_dir, str(data_ref))
        if candidate.exists() and _font_covers(candidate, text):
            return candidate

    # Tier 2: bundled fallback
    return resolve_fallback(
        font_resource.get("family", ""),
        int(font_resource.get("weight", 400)),
        font_resource.get("style", "normal"),
    )


def _font_covers(font_path: Path, text: str) -> bool:
    """True if every codepoint in ``text`` has a glyph in the font file."""
    try:
        font = pymupdf.Font(fontfile=str(font_path))
    except Exception:
        return False
    for ch in text:
        try:
            if not font.has_glyph(ord(ch)):
                return False
        except Exception:
            return False
    return True


def _font_by_id(udm: dict[str, Any], font_id: str | None) -> dict[str, Any] | None:
    if not font_id:
        return None
    for f in udm.get("resources", {}).get("fonts", []):
        if f.get("id") == font_id:
            return f
    return None


def _base14_for(font_resource: dict[str, Any] | None) -> str:
    weight = int((font_resource or {}).get("weight", 400))
    style = (font_resource or {}).get("style", "normal")
    is_bold = weight >= 600
    is_italic = style in ("italic", "oblique")
    if is_bold and is_italic:
        return "hebi"
    if is_bold:
        return "hebo"
    if is_italic:
        return "heit"
    return "helv"


def _color_rgb01(color_ref: dict[str, Any]) -> tuple[float, float, float]:
    literal = (color_ref or {}).get("literal") or {}
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
            return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)
    return (0.0, 0.0, 0.0)


def _resolve_relative(base: Path, ref: str) -> Path:
    return (base / ref.lstrip("/")).resolve()
