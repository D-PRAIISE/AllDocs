"""
Auto-detect form structure on a "visual-only" PDF — turn the
underlines and checkbox squares of a Word-exported document into real
fillable AcroForm fields.

The heuristic walks ``page.get_drawings()`` looking for:
  - long thin horizontal lines or rectangles → text-field blanks
  - small near-square stroked rectangles    → checkbox glyphs

Each candidate's name is borrowed from the nearest text span (label to
the left for text blanks, to the right for checkboxes), falling back
to ``field_N`` when no nearby text exists.

This is a heuristic — the importer only materializes the candidates
when the page has *no* native AcroForm widgets (so we don't duplicate
real forms) and at least two candidates were found (so a single rule
line in a normal text doc doesn't trigger phantom fields).
"""
from __future__ import annotations

from typing import Any

import pymupdf

# Geometry thresholds (PDF points).
_MIN_LINE_WIDTH = 60.0          # blank lines on real forms span this far
_MAX_LINE_HEIGHT = 4.0          # filled-rect "lines" are thinner than this
_MIN_BOX_SIDE = 6.0
_MAX_BOX_SIDE = 22.0
_MAX_BOX_RATIO_DIFF = 4.0       # |w - h| for a "near-square" checkbox

# Don't materialize for trivial counts: a single underline isn't a form.
MIN_CANDIDATES_TO_AUTOFILL = 2

# Field-rect padding above a detected blank line so typing aligns to it.
_TEXT_FIELD_HEIGHT = 16.0
_TEXT_FIELD_LIFT = 14.0         # how far above the line the field starts


def detect_form_candidates(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Return candidates: ``[{kind, rect, name}]``."""
    candidates: list[dict[str, Any]] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return candidates

    for d in drawings:
        stroke = d.get("color")
        for item in d.get("items", []) or []:
            if not item:
                continue
            op = item[0]
            if op == "re":
                try:
                    rect = pymupdf.Rect(item[1])
                except Exception:
                    continue
                w, h = rect.width, rect.height
                # Filled hairline rect: a text-blank
                if w >= _MIN_LINE_WIDTH and 0 < h <= _MAX_LINE_HEIGHT:
                    candidates.append(
                        {
                            "kind": "text",
                            "rect": pymupdf.Rect(
                                rect.x0,
                                rect.y0 - _TEXT_FIELD_LIFT,
                                rect.x1,
                                rect.y0 + max(2.0, h),
                            ),
                            "src": rect,
                        }
                    )
                # Small near-square stroked rect: a checkbox glyph
                elif (
                    stroke is not None
                    and _MIN_BOX_SIDE <= w <= _MAX_BOX_SIDE
                    and _MIN_BOX_SIDE <= h <= _MAX_BOX_SIDE
                    and abs(w - h) <= _MAX_BOX_RATIO_DIFF
                ):
                    candidates.append({"kind": "checkbox", "rect": rect, "src": rect})
            elif op == "l":
                try:
                    p1, p2 = item[1], item[2]
                    x0, y0 = float(p1.x), float(p1.y)
                    x1, y1 = float(p2.x), float(p2.y)
                except Exception:
                    continue
                if abs(y0 - y1) <= 1.0 and abs(x0 - x1) >= _MIN_LINE_WIDTH:
                    lx0, lx1 = min(x0, x1), max(x0, x1)
                    ly = (y0 + y1) / 2.0
                    candidates.append(
                        {
                            "kind": "text",
                            "rect": pymupdf.Rect(
                                lx0,
                                ly - _TEXT_FIELD_LIFT,
                                lx1,
                                ly + 2.0,
                            ),
                            "src": pymupdf.Rect(lx0, ly, lx1, ly),
                        }
                    )

    candidates = _dedup(candidates)
    _attach_labels(page, candidates)
    return candidates


def _dedup(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove candidates whose source rect overlaps an earlier one
    significantly — two ops drawn on top of each other for emphasis."""
    out: list[dict[str, Any]] = []
    for c in candidates:
        sr = c.get("src") or c["rect"]
        dup = False
        for prev in out:
            psr = prev.get("src") or prev["rect"]
            if _rects_close(sr, psr, tol=3.0):
                dup = True
                break
        if not dup:
            out.append(c)
    return out


def _rects_close(a: pymupdf.Rect, b: pymupdf.Rect, tol: float) -> bool:
    return (
        abs(a.x0 - b.x0) <= tol
        and abs(a.y0 - b.y0) <= tol
        and abs(a.x1 - b.x1) <= tol
        and abs(a.y1 - b.y1) <= tol
    )


def _attach_labels(page: pymupdf.Page, candidates: list[dict[str, Any]]) -> None:
    """Borrow the nearest text span as each field's name."""
    spans: list[dict[str, Any]] = []
    try:
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = (span.get("text") or "").strip()
                    if text:
                        spans.append({"text": text, "bbox": pymupdf.Rect(span["bbox"])})
    except Exception:
        spans = []

    used_names: set[str] = set()
    for i, c in enumerate(candidates):
        rect: pymupdf.Rect = c["rect"]
        label = (
            _nearest_left_label(spans, rect)
            if c["kind"] == "text"
            else (_nearest_right_label(spans, rect) or _nearest_left_label(spans, rect))
        )
        name = _slug(label) if label else f"field_{i + 1}"
        # Disambiguate duplicates.
        base = name
        n = 2
        while name in used_names:
            name = f"{base}_{n}"
            n += 1
        used_names.add(name)
        c["name"] = name


def _nearest_left_label(spans: list[dict[str, Any]], rect: pymupdf.Rect) -> str | None:
    """Span whose right edge is just to the left of the field on the
    same row. Picks the closest such span within 200pt."""
    best: tuple[float, str] | None = None
    cy = (rect.y0 + rect.y1) / 2
    for s in spans:
        b: pymupdf.Rect = s["bbox"]
        if b.x1 > rect.x0 + 2:  # must be to the left
            continue
        if not (b.y0 - 4 <= cy <= b.y1 + 4):  # same row
            continue
        d = rect.x0 - b.x1
        if d < 0 or d > 200:
            continue
        if best is None or d < best[0]:
            best = (d, s["text"])
    return best[1] if best else None


def _nearest_right_label(spans: list[dict[str, Any]], rect: pymupdf.Rect) -> str | None:
    best: tuple[float, str] | None = None
    cy = (rect.y0 + rect.y1) / 2
    for s in spans:
        b: pymupdf.Rect = s["bbox"]
        if b.x0 < rect.x1 - 2:
            continue
        if not (b.y0 - 4 <= cy <= b.y1 + 4):
            continue
        d = b.x0 - rect.x1
        if d < 0 or d > 80:
            continue
        if best is None or d < best[0]:
            best = (d, s["text"])
    return best[1] if best else None


def _slug(text: str) -> str:
    """Normalize a label string into a usable field name."""
    out = []
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_") and out and out[-1] != "_":
            out.append("_")
    s = "".join(out).strip("_")
    return s[:60] or "field"
