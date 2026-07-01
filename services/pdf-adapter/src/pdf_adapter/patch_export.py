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
    password: str | None = None,
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

    ``password``: if given, the patched output is encrypted with AES-256
    using this string as both owner and user password. If the source
    PDF was itself encrypted, opening it requires the user to have
    supplied that password upstream (the importer authenticates and
    we work against an unlocked document here).
    """
    passthrough = (udm.get("metadata") or {}).get("passthrough") or {}
    source_url = passthrough.get("source_url")
    if not source_url:
        return False

    source_path = _resolve_relative(base_dir, source_url)
    if not source_path.exists():
        return False

    doc = pymupdf.open(str(source_path))
    # Encrypted source: PyMuPDF returns the doc in a locked state and
    # iterating pages raises "document closed or encrypted". Try the
    # empty-password unlock first (covers owner-only encryption — common,
    # silent at import time). If that fails, the source needs a user
    # password we don't have here (we deliberately don't store it), so
    # return False and let the render path build a fresh PDF from UDM.
    if doc.needs_pass:
        if not doc.authenticate(""):
            doc.close()
            return False
    rebuilt: pymupdf.Document | None = None
    try:
        # Page operations (reorder / delete / insert / rotate) rebuild the
        # document: a fresh doc with the source pages copied in UDM order
        # (insert_pdf preserves each page verbatim) plus any blank inserts
        # and rotations. After the rebuild, output page i corresponds to
        # UDM page i, so the content-patch logic below works unchanged.
        page_ops = _page_ops_needed(udm, doc)
        if page_ops:
            rebuilt = _rebuild_pages(doc, udm)
        work = rebuilt if rebuilt is not None else doc

        # Image swaps are orthogonal to text edits — a UDM image resource
        # whose data_ref became a data: URL means the user replaced it.
        image_swaps = _diff_image_resources(udm)
        # Net-new content the user added in the editor.
        added_runs = _diff_added_runs(udm)
        added_images = _diff_added_images(udm)
        added_annots = _diff_added_annotations(udm)
        form_ops = _diff_form_fields(udm, work)
        has_additions = bool(added_runs or added_images or added_annots or form_ops)

        # OCR docs (scanned / rasterized — text sits over an image) take a
        # separate path: there are no source text spans to redact, so we
        # cover the old pixels and draw the new text on top.
        if _udm_has_ocr_runs(udm):
            ocr_edits = _diff_ocr_runs(udm)
            if not ocr_edits and not image_swaps and not page_ops and not has_additions:
                return False
            for page_idx, page_edits in ocr_edits.items():
                if page_idx >= len(work):
                    continue
                page = work[page_idx]
                for e in page_edits:
                    page.draw_rect(e["cover_rect"], color=None, fill=e["bg_color"])
                    _insert_replacement(page, e, udm, base_dir)
            _apply_added_content(work, udm, added_runs, added_images, base_dir)
            _apply_added_annotations(work, added_annots)
            _apply_form_fields(work, form_ops)
            _apply_image_swaps(work, image_swaps)
            _save(work, output_path, password)
            return True

        shape_edits, shape_blocked = _diff_shapes(udm, work)
        if shape_blocked:
            # A recolored shape overlaps an image — drawing the new fill
            # over it would hide the image. Fall through to full render.
            return False

        edits_by_page, fully_patchable = _diff_runs(udm, work)
        # When page ops happened we always have a result to write (the
        # rebuilt doc); content edits we can't cleanly diff are simply
        # skipped rather than discarding the page reordering.
        if not fully_patchable and not page_ops:
            return False
        if (
            not edits_by_page
            and not image_swaps
            and not page_ops
            and not shape_edits
            and not has_additions
        ):
            # No edits to apply but fingerprint differs (otherwise passthrough
            # would have fired). Treat as fall-through to render.
            return False

        # Apply: queue all redacts on a page, apply them once, then insert
        # all new text. Doing inserts after apply_redactions avoids the
        # new text getting erased.
        if fully_patchable:
            for page_idx, page_edits in edits_by_page.items():
                page = work[page_idx]
                # Lesson #8 — neighbor preservation. PyMuPDF's
                # apply_redactions removes the whole text-show op when
                # the rect touches any of its glyphs, which can wipe
                # adjacent spans we didn't mean to touch. Snapshot pre-
                # vs post-redaction spans, then re-insert any
                # unintended casualties using their original font.
                pre_spans = _collect_spans(page)
                intended_rects = [pymupdf.Rect(*e["rect"]) for e in page_edits]
                for e in page_edits:
                    page.add_redact_annot(e["rect"], fill=None)
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
                post_spans = _collect_spans(page)
                _reinsert_collateral_spans(
                    page, pre_spans, post_spans, intended_rects, udm, base_dir
                )
                for e in page_edits:
                    _insert_replacement(page, e, udm, base_dir)

        _apply_shape_recolors(work, udm, shape_edits, base_dir)
        _apply_added_content(work, udm, added_runs, added_images, base_dir)
        _apply_added_annotations(work, added_annots)
        _apply_form_fields(work, form_ops)
        _apply_image_swaps(work, image_swaps)
        _save(work, output_path, password)
        return True
    finally:
        doc.close()
        if rebuilt is not None:
            rebuilt.close()


def _page_ops_needed(udm: dict[str, Any], source_doc: pymupdf.Document) -> bool:
    """True if the UDM's page set differs structurally from the source —
    pages reordered, deleted, inserted, or rotated."""
    pages = (udm.get("content") or {}).get("pages") or []
    if len(pages) != len(source_doc):
        return True
    for i, page in enumerate(pages):
        sp = (page.get("_meta") or {}).get("source_page")
        if sp != i:  # reordered, or inserted (sp is None)
            return True
        rot = int(page.get("rotation") or 0)
        src_rot = int(source_doc[i].rotation or 0) if i < len(source_doc) else 0
        if rot != src_rot:
            return True
    return False


def _rebuild_pages(source_doc: pymupdf.Document, udm: dict[str, Any]) -> pymupdf.Document:
    """Build a fresh document from the UDM page list. Each page is either
    copied verbatim from the source (insert_pdf preserves all content) or
    created blank (an inserted page). Per-page rotation is applied.

    Output page i corresponds to UDM page i, so the content-patch logic
    can run against the rebuilt doc unchanged.
    """
    out = pymupdf.open()
    pages = (udm.get("content") or {}).get("pages") or []
    for page in pages:
        sp = (page.get("_meta") or {}).get("source_page")
        if sp is not None and 0 <= sp < len(source_doc):
            out.insert_pdf(source_doc, from_page=sp, to_page=sp)
        else:
            width = float((page.get("width") or {}).get("value", 612))
            height = float((page.get("height") or {}).get("value", 792))
            out.new_page(width=width, height=height)
        rot = int(page.get("rotation") or 0)
        if rot:
            out[-1].set_rotation(rot)
    return out


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


# ---- Shape recolor --------------------------------------------------------


def _rects_close(a: pymupdf.Rect, b: pymupdf.Rect, tol: float = 1.5) -> bool:
    return (
        abs(a.x0 - b.x0) <= tol
        and abs(a.y0 - b.y0) <= tol
        and abs(a.x1 - b.x1) <= tol
        and abs(a.y1 - b.y1) <= tol
    )


def _rects_intersect(a: pymupdf.Rect, b: pymupdf.Rect) -> bool:
    return not (a.x1 <= b.x0 or b.x1 <= a.x0 or a.y1 <= b.y0 or b.y1 <= a.y0)


def _rgb_close(
    a: tuple[float, float, float], b: tuple[float, float, float], tol: float = 0.02
) -> bool:
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


def _geom_rect(geom: dict[str, Any]) -> pymupdf.Rect | None:
    if geom.get("kind") != "rect":
        return None
    try:
        x = float(geom["x"]["value"])
        y = float(geom["y"]["value"])
        w = float(geom["w"]["value"])
        h = float(geom["h"]["value"])
    except (KeyError, TypeError, ValueError):
        return None
    return pymupdf.Rect(x, y, x + w, y + h)


def _image_layer_rect(layer: dict[str, Any]) -> pymupdf.Rect | None:
    try:
        x = float(layer["x"]["value"])
        y = float(layer["y"]["value"])
        w = float(layer["width"]["value"])
        h = float(layer["height"]["value"])
    except (KeyError, TypeError, ValueError):
        return None
    return pymupdf.Rect(x, y, x + w, y + h)


def _run_rect(run: dict[str, Any]) -> pymupdf.Rect | None:
    """Approximate bbox of a text run from baseline x/y + size. Width is
    estimated — good enough for overlap detection."""
    try:
        x = float(run["x"]["value"])
        y = float(run["y"]["value"])
        size = float(run["font_size"]["value"])
    except (KeyError, TypeError, ValueError):
        return None
    width = max(len(run.get("text", "")), 1) * size * 0.55
    return pymupdf.Rect(x, y - size, x + width, y)


def _captured_rects(page: pymupdf.Page) -> list[tuple[pymupdf.Rect, Any]]:
    """Re-extract page drawings in the *exact* order and with the
    *exact* filter the importer's _shape_layers_from_drawings uses, so
    the i-th captured entry lines up with the i-th UDM shape layer.

    Entries are ``(rect | None, fill)``. None signals a path-kind shape
    (lines / curves only, no single re item) — the recolor matcher
    skips those since their geometry isn't a simple rectangle.
    """
    out: list[tuple[pymupdf.Rect | None, Any]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return out
    for d in drawings:
        fill = d.get("fill")
        stroke = d.get("color")
        if fill is None and stroke is None:
            continue
        items = d.get("items") or []
        # Mirror the importer: single-re drawing -> kind=rect; anything
        # else with content -> kind=path.
        if len(items) == 1 and items[0] and items[0][0] == "re":
            try:
                r = pymupdf.Rect(items[0][1])
            except Exception:
                continue
            if r.width <= 0 or r.height <= 0:
                continue
            out.append((r, fill))
        elif items:
            # Path-kind placeholder so positional alignment with the
            # UDM shape list survives.
            out.append((None, fill))
    return out


def _diff_shapes(
    udm: dict[str, Any], work: pymupdf.Document
) -> tuple[dict[int, list[dict[str, Any]]], bool]:
    """Find rectangle shapes whose fill the user recolored.

    UDM shape layers and source rect drawings are matched *by capture
    order* (both produced by the same get_drawings() walk), not by
    geometry — geometry matching is ambiguous when shapes stack. If the
    counts don't line up for a page, shape diffing is skipped there
    rather than risk a false positive.

    Returns (edits_by_page, blocked). ``blocked`` is True if a recolored
    shape overlaps an image — drawing the new fill over it would hide
    the image, so the caller must fall back to a full render.
    """
    from collections import defaultdict

    edits: dict[int, list[dict[str, Any]]] = defaultdict(list)
    blocked = False
    pages = (udm.get("content") or {}).get("pages") or []

    for i, page in enumerate(pages):
        if i >= len(work):
            continue
        captured = _captured_rects(work[i])
        udm_shapes = [
            (li, layer)
            for li, layer in enumerate(page.get("layers", []))
            if layer.get("type") == "shape"
        ]
        if len(udm_shapes) != len(captured):
            # Can't reliably align — skip shape diffing for this page.
            continue

        image_rects = [
            r
            for layer in page.get("layers", [])
            if layer.get("type") == "image"
            for r in [_image_layer_rect(layer)]
            if r is not None
        ]

        for (li, layer), (src_rect, src_fill) in zip(udm_shapes, captured):
            # Path-kind UDM shapes / path-kind source drawings are
            # skipped: recolor is only well-defined for rect geometry.
            if src_rect is None:
                continue
            udm_rect = _geom_rect(layer.get("geometry") or {})
            if udm_rect is None:
                continue
            fill_ref = (layer.get("fill") or {}).get("color")
            if not fill_ref:
                continue
            if not isinstance(src_fill, (tuple, list)) or len(src_fill) < 3:
                continue
            udm_fill = _color_rgb01(fill_ref)
            if _rgb_close((src_fill[0], src_fill[1], src_fill[2]), udm_fill):
                continue  # unchanged

            if any(_rects_intersect(udm_rect, ir) for ir in image_rects):
                blocked = True
                continue
            edits[i].append({"rect": udm_rect, "fill": udm_fill, "layer_index": li})

    return dict(edits), blocked


def _apply_shape_recolors(
    work: pymupdf.Document,
    udm: dict[str, Any],
    edits: dict[int, list[dict[str, Any]]],
    base_dir: Path,
) -> None:
    """Recolor each shape by drawing the new fill over it, then redrawing
    anything that paints above it within the rect — later shapes and any
    overlapping text (re-inserted with the run's own font)."""
    pages = (udm.get("content") or {}).get("pages") or []
    for page_idx, page_edits in edits.items():
        if page_idx >= len(work):
            continue
        page = work[page_idx]
        udm_page = pages[page_idx]
        layers = udm_page.get("layers", [])
        for e in page_edits:
            rect: pymupdf.Rect = e["rect"]
            page.draw_rect(rect, color=None, fill=e["fill"])

            # Later shapes overlapping the rect would have been covered —
            # redraw them in order on top.
            for li in range(e["layer_index"] + 1, len(layers)):
                layer = layers[li]
                if layer.get("type") != "shape":
                    continue
                lr = _geom_rect(layer.get("geometry") or {})
                if lr is None or not _rects_intersect(lr, rect):
                    continue
                lf = _color_rgb01((layer.get("fill") or {}).get("color") or {})
                page.draw_rect(lr, color=None, fill=lf)

            # Text overlapping the rect: re-insert on top with its own font.
            for layer in layers:
                if layer.get("type") != "text":
                    continue
                for run in layer.get("runs", []):
                    rr = _run_rect(run)
                    if rr is None or not _rects_intersect(rr, rect):
                        continue
                    size = float(run["font_size"]["value"])
                    _insert_replacement(
                        page,
                        {
                            "new_text": run.get("text", ""),
                            "baseline": (
                                float(run["x"]["value"]),
                                float(run["y"]["value"]) - size * 0.2,
                            ),
                            "font_size": size,
                            "color": run.get("color") or {},
                            "font_id": run.get("font_id"),
                        },
                        udm,
                        base_dir,
                    )


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
                # Re-insert when the text changed OR the client flagged a
                # style-only edit (colour/size/opacity) via _meta.edited —
                # a text diff alone would miss those.
                if not meta.get("edited") and (original is None or original == current):
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


def _save(work: pymupdf.Document, output_path: str | Path, password: str | None) -> None:
    """Save the patched document. Encrypts with AES-256 when a password
    is supplied; otherwise writes unprotected. Matches the render
    path's save settings."""
    kwargs: dict[str, Any] = {"garbage": 4, "deflate": True, "clean": True}
    if password:
        kwargs["encryption"] = pymupdf.PDF_ENCRYPT_AES_256
        kwargs["owner_pw"] = password
        kwargs["user_pw"] = password
    work.save(str(output_path), **kwargs)


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
                # Added runs are net-new content with no source span —
                # _diff_added_runs handles them; skip here.
                if (run.get("_meta") or {}).get("added"):
                    continue
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

                # Skip only when the text is unchanged AND the client didn't
                # flag a style-only edit (colour/size/opacity) via _meta.edited.
                if src_span["text"] == udm_text and not (run.get("_meta") or {}).get("edited"):
                    continue  # No change to this run

                bbox = src_span["bbox"]
                # NOTE on lesson #8 (character-level redaction): PyMuPDF's
                # apply_redactions removes a text-show op whole when the
                # redact rect overlaps any of its glyphs — shrinking the
                # rect to the changed-glyph window doesn't actually save
                # the surround. The only robust fix is post-redact
                # re-insertion of the prefix/suffix using the same font
                # at the same baseline. That's a sizeable lift; for now
                # the existing "redact full span + insert full new_text"
                # approach is correct because new_text already includes
                # the unchanged prefix/suffix. Lesson #8 is still open.
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


def _diff_added_runs(udm: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """Collect text runs the user added in the editor (marked
    ``_meta.added``). These are net-new — inserted, never redacted."""
    from collections import defaultdict

    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pages = (udm.get("content") or {}).get("pages") or []
    for i, page in enumerate(pages):
        for layer in page.get("layers", []):
            if layer.get("type") != "text":
                continue
            for run in layer.get("runs", []):
                if not (run.get("_meta") or {}).get("added"):
                    continue
                if not run.get("text"):
                    continue
                try:
                    size = float(run["font_size"]["value"])
                    x = float(run["x"]["value"])
                    y = float(run["y"]["value"])
                except (KeyError, TypeError, ValueError):
                    continue
                out[i].append(
                    {
                        "added": True,
                        "baseline": (x, y - size * 0.2),
                        "new_text": run.get("text", ""),
                        "font_id": run.get("font_id"),
                        "font_size": size,
                        "color": run.get("color") or {},
                    }
                )
    return dict(out)


def _diff_added_images(udm: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """Collect image layers the user added — their resource has a
    data: URL and no ``_meta.xref`` (a brand-new image, not a
    replacement of an existing one). Returns per-page (rect, bytes)."""
    import base64
    from collections import defaultdict

    resources = {
        r.get("id"): r for r in (udm.get("resources") or {}).get("images", []) or []
    }
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pages = (udm.get("content") or {}).get("pages") or []
    for i, page in enumerate(pages):
        for layer in page.get("layers", []):
            if layer.get("type") != "image":
                continue
            res = resources.get(layer.get("image_id"))
            if not res:
                continue
            data_ref = str(res.get("data_ref") or "")
            if not data_ref.startswith("data:"):
                continue
            if (res.get("_meta") or {}).get("xref"):
                continue  # a replacement, handled by _diff_image_resources
            rect = _image_layer_rect(layer)
            if rect is None:
                continue
            comma = data_ref.find(",")
            if comma < 0:
                continue
            try:
                raw = base64.b64decode(data_ref[comma + 1 :])
            except Exception:
                continue
            if raw:
                out[i].append({"rect": rect, "bytes": raw})
    return dict(out)


def _apply_added_content(
    work: pymupdf.Document,
    udm: dict[str, Any],
    added_runs: dict[int, list[dict[str, Any]]],
    added_images: dict[int, list[dict[str, Any]]],
    base_dir: Path,
) -> None:
    """Insert net-new text runs and images onto their pages."""
    for page_idx, imgs in added_images.items():
        if page_idx >= len(work):
            continue
        for img in imgs:
            try:
                work[page_idx].insert_image(img["rect"], stream=img["bytes"])
            except Exception:
                continue
    for page_idx, runs in added_runs.items():
        if page_idx >= len(work):
            continue
        for edit in runs:
            _insert_replacement(work[page_idx], edit, udm, base_dir)


def _diff_form_fields(
    udm: dict[str, Any], work: pymupdf.Document
) -> dict[int, list[dict[str, Any]]]:
    """Per-page list of form-field operations: ``{action: "add"|"update", ...}``.

      - ``add``: the field has ``_meta.added`` — create a new widget.
      - ``update``: the field exists in the source (matched by name)
        and its value differs from the live widget value.
    """
    from collections import defaultdict

    ops: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pages = (udm.get("content") or {}).get("pages") or []
    for i, page in enumerate(pages):
        if i >= len(work):
            continue
        try:
            live = {w.field_name: w for w in work[i].widgets() if w.field_name}
        except Exception:
            live = {}
        for layer in page.get("layers", []):
            if layer.get("type") != "form":
                continue
            for field in layer.get("fields", []) or []:
                meta = field.get("_meta") or {}
                name = field.get("name") or ""
                value = field.get("value")
                kind = field.get("kind") or "text"
                if meta.get("added"):
                    ops[i].append({"action": "add", "field": field})
                    continue
                # Radios in the same group share field_name — disambiguate
                # by xref so we update the specific button the user picked.
                if kind == "radio":
                    xref = meta.get("xref")
                    if xref is None:
                        continue
                    ops[i].append(
                        {"action": "update_radio", "xref": int(xref), "value": value}
                    )
                    continue
                w = live.get(name)
                if w is None:
                    continue
                if str(w.field_value or "") != str(value if value is not None else ""):
                    ops[i].append({"action": "update", "name": name, "value": value})
    return dict(ops)


def _apply_form_fields(
    work: pymupdf.Document,
    ops_by_page: dict[int, list[dict[str, Any]]],
) -> None:
    for page_idx, ops in ops_by_page.items():
        if page_idx >= len(work):
            continue
        page = work[page_idx]
        # Update existing widgets first (matched by name).
        updates = {o["name"]: o["value"] for o in ops if o["action"] == "update"}
        # Radios: matched by xref since they share names within a group.
        radio_updates = {
            int(o["xref"]): o["value"] for o in ops if o["action"] == "update_radio"
        }
        if updates or radio_updates:
            try:
                for w in page.widgets():
                    if radio_updates and w.field_type_string == "RadioButton":
                        try:
                            xref = int(w.xref)
                        except Exception:
                            xref = None
                        if xref is not None and xref in radio_updates:
                            v = radio_updates[xref]
                            try:
                                # Either the captured on-value ("Yes",
                                # "Male", …) or "Off" — both are valid
                                # PDF radio field_value strings.
                                w.field_value = (
                                    "Off" if v in (None, False, "Off", "") else str(v)
                                )
                                w.update()
                            except Exception:
                                pass
                            continue
                    if w.field_name in updates:
                        v = updates[w.field_name]
                        try:
                            if w.field_type_string == "CheckBox":
                                # PyMuPDF expects 'Yes' / 'Off' for checkbox values.
                                w.field_value = bool(v) and "Yes" or "Off"
                            else:
                                w.field_value = "" if v is None else str(v)
                            w.update()
                        except Exception:
                            continue
            except Exception:
                pass
        # Add new widgets.
        for op in ops:
            if op["action"] != "add":
                continue
            field = op["field"]
            try:
                kind = field.get("kind", "text")
                rect = field.get("rect") or {}
                r = pymupdf.Rect(
                    float(rect["x"]),
                    float(rect["y"]),
                    float(rect["x"]) + float(rect["w"]),
                    float(rect["y"]) + float(rect["h"]),
                )
                widget = pymupdf.Widget()
                widget.rect = r
                widget.field_name = field.get("name") or f"field_{id(field)}"
                if kind == "checkbox":
                    widget.field_type = pymupdf.PDF_WIDGET_TYPE_CHECKBOX
                    widget.field_value = "Yes" if field.get("value") else "Off"
                elif kind == "radio":
                    # Radios in the same group share field_name; each
                    # button's on-value is stored in _meta.on_value.
                    on_value = (field.get("_meta") or {}).get("on_value") or "On"
                    widget.field_type = pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON
                    widget.button_caption = on_value
                    v = field.get("value")
                    widget.field_value = (
                        "Off" if v in (None, False, "Off", "") else str(v)
                    )
                else:
                    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
                    widget.field_value = str(field.get("value") or "")
                page.add_widget(widget)
            except Exception:
                continue


def _diff_added_annotations(udm: dict[str, Any]) -> dict[int, list[dict[str, Any]]]:
    """Collect annotation layers the user added in the editor (the
    annotation's ``data._meta.added`` is set). Highlight / comment / ink
    are supported in v1."""
    from collections import defaultdict

    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    pages = (udm.get("content") or {}).get("pages") or []
    for i, page in enumerate(pages):
        for layer in page.get("layers", []):
            if layer.get("type") != "annotation":
                continue
            data = layer.get("data") or {}
            if not isinstance(data, dict):
                continue
            if not (data.get("_meta") or {}).get("added"):
                continue
            out[i].append({"kind": layer.get("kind"), "data": data})
    return dict(out)


def _apply_added_annotations(
    work: pymupdf.Document,
    annots: dict[int, list[dict[str, Any]]],
) -> None:
    """Create proper PDF annotations on the rebuilt/source doc."""
    for page_idx, items in annots.items():
        if page_idx >= len(work):
            continue
        page = work[page_idx]
        for item in items:
            kind = item.get("kind")
            data = item.get("data") or {}
            try:
                if kind == "highlight":
                    rect = data.get("rect") or {}
                    r = pymupdf.Rect(
                        float(rect["x"]),
                        float(rect["y"]),
                        float(rect["x"]) + float(rect["w"]),
                        float(rect["y"]) + float(rect["h"]),
                    )
                    annot = page.add_highlight_annot(r)
                    _set_annot_color(annot, data.get("color"), default=(1.0, 0.92, 0.23))
                elif kind == "comment":
                    point = pymupdf.Point(float(data["x"]), float(data["y"]))
                    annot = page.add_text_annot(point, str(data.get("text") or ""))
                    _set_annot_color(annot, data.get("color"), default=(1.0, 0.85, 0.0))
                elif kind == "ink":
                    strokes_raw = data.get("strokes") or []
                    strokes = [
                        [pymupdf.Point(float(p[0]), float(p[1])) for p in s if len(p) >= 2]
                        for s in strokes_raw
                        if isinstance(s, list)
                    ]
                    strokes = [s for s in strokes if len(s) >= 2]
                    if not strokes:
                        continue
                    annot = page.add_ink_annot(strokes)
                    _set_annot_color(annot, data.get("color"), default=(0.0, 0.0, 0.0))
                    width = data.get("width")
                    if width:
                        try:
                            annot.set_border(width=float(width))
                        except Exception:
                            pass
                    annot.update()
            except Exception:
                # Skip a bad annotation rather than abort the whole export.
                continue


def _set_annot_color(annot: Any, color: Any, default: tuple[float, float, float]) -> None:
    """Apply a 0-255 RGB list (or fall back to ``default`` in 0-1)."""
    try:
        if isinstance(color, (list, tuple)) and len(color) >= 3:
            rgb = (float(color[0]) / 255.0, float(color[1]) / 255.0, float(color[2]) / 255.0)
        else:
            rgb = default
        annot.set_colors(stroke=rgb)
        annot.update()
    except Exception:
        pass


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


def _reinsert_collateral_spans(
    page: pymupdf.Page,
    pre_spans: list[dict[str, Any]],
    post_spans: list[dict[str, Any]],
    intended_rects: list[pymupdf.Rect],
    udm: dict[str, Any],
    base_dir: Path,
) -> None:
    """Re-insert spans that apply_redactions removed as collateral.

    PyMuPDF redacts whole text-show ops; adjacent spans whose bboxes
    barely touch a redact rect get wiped along with the intended
    target. We detect that by diffing the pre/post span sets and
    inserting any pre-only span that the user did NOT intend to remove
    (i.e., the span's bbox doesn't overlap any of the intended rects).

    Inserted spans use the source's recorded font / size / color, so
    the surround visually matches the original (lesson #8).
    """
    if not pre_spans:
        return

    def _key(s: dict[str, Any]) -> tuple[str, int, int, int, int]:
        bb = s["bbox"]
        return (
            s.get("text", ""),
            int(round(float(bb[0]))),
            int(round(float(bb[1]))),
            int(round(float(bb[2]))),
            int(round(float(bb[3]))),
        )

    post_keys = {_key(s) for s in post_spans}

    def _rect_overlaps_any(span_bbox: Any, rects: list[pymupdf.Rect]) -> bool:
        try:
            sx0, sy0, sx1, sy1 = (
                float(span_bbox[0]),
                float(span_bbox[1]),
                float(span_bbox[2]),
                float(span_bbox[3]),
            )
        except Exception:
            return False
        for r in rects:
            # Standard AABB overlap test.
            if (
                sx0 < r.x1
                and sx1 > r.x0
                and sy0 < r.y1
                and sy1 > r.y0
            ):
                return True
        return False

    # Build a font lookup once.
    fonts_by_id: dict[str, dict[str, Any]] = {}
    for f in (udm.get("resources") or {}).get("fonts", []) or []:
        if isinstance(f, dict) and "id" in f:
            fonts_by_id[f["id"]] = f

    # Map source-PDF span "font" name → our font resource id when we can.
    name_to_fontid: dict[str, str] = {}
    for fid, fres in fonts_by_id.items():
        fam = str(fres.get("family") or "").lower()
        if fam:
            name_to_fontid[fam] = fid

    for pre in pre_spans:
        if _key(pre) in post_keys:
            continue  # Survived — no reinsertion needed.
        # Did the user actually mean to redact this? If its bbox
        # overlaps any intended rect at all, treat it as intended
        # (the replacement insert will handle the visual result).
        if _rect_overlaps_any(pre["bbox"], intended_rects):
            continue
        # Collateral damage — restore using its own font metadata.
        text = pre.get("text", "")
        if not text.strip():
            continue
        size = float(pre.get("size") or 12)
        color_int = int(pre.get("color") or 0)
        rgb = (
            ((color_int >> 16) & 0xFF) / 255.0,
            ((color_int >> 8) & 0xFF) / 255.0,
            (color_int & 0xFF) / 255.0,
        )
        x0 = float(pre["bbox"][0])
        y1 = float(pre["bbox"][3])
        # Resolve a font: try the source font name → our font resource;
        # fall back to a Latin-friendly resource.
        font_resource = None
        src_font_name = str(pre.get("font") or "").lower()
        for fam, fid in name_to_fontid.items():
            if fam in src_font_name or src_font_name in fam:
                font_resource = fonts_by_id.get(fid)
                break
        font_file = _pick_font_for_text(font_resource, text, base_dir)
        try:
            if font_file is not None:
                fontname = f"udm_reins_{abs(hash(str(font_file))) & 0xFFFFFFFF:x}"
                try:
                    page.insert_font(fontname=fontname, fontfile=str(font_file))
                except Exception:
                    fontname = None  # type: ignore
                if fontname:
                    page.insert_text(
                        (x0, y1),
                        text,
                        fontsize=size,
                        color=rgb,
                        fontname=fontname,
                    )
                    continue
            # Fallback: base-14 helvetica.
            page.insert_text(
                (x0, y1),
                text,
                fontsize=size,
                color=rgb,
                fontname="helv",
            )
        except Exception:
            # A single failed reinsertion shouldn't abort the export;
            # the patch path stays best-effort.
            continue


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
    alpha = _color_alpha(edit["color"])
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
            fill_opacity=alpha,
            fontname=f"udm_patch_{edit.get('font_id') or 'unknown'}",
        )
    else:
        page.insert_text(
            (x, y),
            new_text,
            fontsize=size,
            color=color,
            fill_opacity=alpha,
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
        return resolve_fallback("", 400, "normal", text=text)

    # Tier 1: extracted subset
    data_ref = font_resource.get("data_ref")
    if data_ref and not str(data_ref).startswith(("http://", "https://", "xref:")):
        candidate = _resolve_relative(base_dir, str(data_ref))
        if candidate.exists() and _font_covers(candidate, text):
            return candidate

    # Tier 2: bundled fallback (with CJK detour when text has CJK chars
    # and a system CJK font is available).
    return resolve_fallback(
        font_resource.get("family", ""),
        int(font_resource.get("weight", 400)),
        font_resource.get("style", "normal"),
        text=text,
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


def _color_alpha(color_ref: dict[str, Any]) -> float:
    """Text opacity (0..1) from a colour ref's alpha channel (0..255).
    Defaults to fully opaque when no alpha is present."""
    literal = (color_ref or {}).get("literal") or {}
    if literal.get("kind") == "rgb" and literal.get("a") is not None:
        try:
            return max(0.0, min(1.0, float(literal["a"]) / 255.0))
        except (TypeError, ValueError):
            return 1.0
    return 1.0


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
