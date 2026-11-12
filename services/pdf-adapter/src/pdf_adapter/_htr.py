"""Handwriting recognition: find the lines, then read them.

Tesseract is a glyph-and-dictionary engine with no language model worth
the name, and it cannot read cursive — on real photos of a notepad it
returned a few dozen characters a page, all of them from the printed
header. Handwriting needs a different kind of model.

TrOCR (Microsoft) is that model, and it is **line-level**: it takes one
cropped image of a single text line and returns the text. It has no
notion of a page. So the work splits in two, and the half that is not
the model is the larger half:

  1. segmentation — find each line of handwriting on the page;
  2. recognition — run TrOCR over each crop and reassemble.

Only step 2 needs torch. Step 1 is OpenCV, which the adapter already
has, and it is the part that decides whether the result is any good: a
line boundary in the wrong place cannot be recovered by a better
recogniser.

Self-hosted on purpose. Nothing here sends a page anywhere.
"""

from __future__ import annotations

from typing import Any

try:
    import cv2
    import numpy as np

    _CV = True
except Exception:  # pragma: no cover
    _CV = False


# --- segmentation tuning --------------------------------------------------
#
# All lengths are fractions of the page's smaller dimension, so the same
# numbers work on a 964px phone photo and a 2560px one.

#: Rules on lined paper are longer than any word. Anything horizontal and
#: at least this fraction of the page width is furniture, not ink.
RULE_MIN_WIDTH_FRAC = 0.35
#: Characters within this fraction of the page width get merged into one
#: line. Too small and a line breaks at every word gap; too large and
#: two columns become one line.
WORD_GAP_FRAC = 0.035
#: A line of handwriting is at least this tall. Below it we are looking
#: at speckle, a stray dot, or the remains of a rule.
MIN_LINE_HEIGHT_FRAC = 0.012
#: ...and no taller than this. Above it the blob is a figure, a block of
#: shading, or several lines that failed to separate.
MAX_LINE_HEIGHT_FRAC = 0.14
#: A line must be at least this wide — a single character is not a line.
MIN_LINE_WIDTH_FRAC = 0.06
#: Two boxes overlapping vertically by more than this are the same line.
MERGE_OVERLAP = 0.5


def available() -> bool:
    """True when segmentation can run (OpenCV present)."""
    return _CV


def segment_lines(pil_rgb: Any) -> list[tuple[int, int, int, int]]:
    """Bounding boxes of the text lines, in reading order.

    Returns ``(x, y, w, h)`` tuples. An empty list means no lines were
    found, which is a valid answer — a photo of a desk has none.
    """
    if not _CV:
        return []

    bgr = cv2.cvtColor(np.array(pil_rgb), cv2.COLOR_RGB2BGR)
    h, w = bgr.shape[:2]
    short = float(min(h, w))

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Adaptive, not Otsu: a page photographed under a lamp has no single
    # threshold that works at both ends of it.
    ink = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 15
    )

    ink = _strip_rules(ink, w)

    # Merge characters into lines. Wide and short: join along the line,
    # never across to the one below.
    gap = max(3, int(w * WORD_GAP_FRAC))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (gap, 3))
    merged = cv2.dilate(ink, kernel, iterations=1)

    found = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = found[0] if len(found) == 2 else found[1]

    min_h = short * MIN_LINE_HEIGHT_FRAC
    max_h = short * MAX_LINE_HEIGHT_FRAC
    min_w = w * MIN_LINE_WIDTH_FRAC

    boxes: list[tuple[int, int, int, int]] = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        if bh < min_h or bh > max_h or bw < min_w:
            continue
        boxes.append((x, y, bw, bh))

    return _merge_same_line(boxes)


def _strip_rules(ink: Any, page_w: int) -> Any:
    """Erase the printed rules of lined paper.

    Without this every line of a notepad is welded to the rule beneath
    it and the whole page merges into one blob. A rule is distinguished
    from handwriting by being longer than any word and perfectly
    horizontal, so a long flat opening finds them and nothing else.
    """
    length = max(10, int(page_w * RULE_MIN_WIDTH_FRAC))
    horizontal = cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1))
    rules = cv2.morphologyEx(ink, cv2.MORPH_OPEN, horizontal, iterations=1)
    # Thicken slightly before subtracting so the rule's anti-aliased
    # edge goes with it, rather than leaving a hairline that still
    # bridges two lines.
    rules = cv2.dilate(rules, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)))
    return cv2.subtract(ink, rules)


def _merge_same_line(
    boxes: list[tuple[int, int, int, int]]
) -> list[tuple[int, int, int, int]]:
    """Combine boxes that are vertically the same line, then sort."""
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: b[1])
    out: list[list[int]] = []
    for x, y, w, h in boxes:
        placed = False
        for cur in out:
            cy, ch = cur[1], cur[3]
            overlap = min(y + h, cy + ch) - max(y, cy)
            if overlap > MERGE_OVERLAP * min(h, ch):
                nx = min(cur[0], x)
                ny = min(cur[1], y)
                cur[2] = max(cur[0] + cur[2], x + w) - nx
                cur[3] = max(cur[1] + cur[3], y + h) - ny
                cur[0], cur[1] = nx, ny
                placed = True
                break
        if not placed:
            out.append([x, y, w, h])
    # Reading order: top to bottom, then left to right for anything
    # sharing a band.
    out.sort(key=lambda b: (b[1], b[0]))
    return [(b[0], b[1], b[2], b[3]) for b in out]
