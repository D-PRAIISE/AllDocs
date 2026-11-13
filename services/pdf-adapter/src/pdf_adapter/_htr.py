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
#: A row counts as part of a line when it carries at least this share
#: of the ink of the busiest row. Relative rather than absolute so the
#: same number works on a dense printed page and a sparse handwritten
#: one.
#:
#: Swept on real photos. At 0.06 the valleys between printed lines never
#: cleared the floor — show-through from the reverse of the page keeps
#: ink in them — and a 24-line references page read as 6. At 0.20 it
#: reads as 20, a handwritten notepad as 13 against 8 actual, and the
#: boxes span 91-97% of the page width throughout, which is the number
#: that matters: a crop holding a whole line is what TrOCR needs, and
#: the contour approach this replaced could never get past about 35%.
ROW_INK_FRACTION = 0.20
#: A line of handwriting is at least this tall. Below it we are looking
#: at speckle, a stray dot, or the remains of a rule.
MIN_LINE_HEIGHT_FRAC = 0.012
#: ...and no taller than this. Above it the blob is a figure, a block of
#: shading, or several lines that failed to separate.
MAX_LINE_HEIGHT_FRAC = 0.14
#: A line must be at least this wide — a single character is not a line.
MIN_LINE_WIDTH_FRAC = 0.06


def available() -> bool:
    """True when segmentation can run (OpenCV present)."""
    return _CV


def segment_lines(pil_rgb: Any) -> list[tuple[int, int, int, int]]:
    """Bounding boxes of the text lines, in reading order.

    Returns ``(x, y, w, h)`` tuples. An empty list means no lines were
    found, which is a valid answer — a photo of a desk has none.

    Uses a horizontal projection profile: count ink per row, and cut
    where the count falls away. This replaced a dilate-and-contour
    approach that did not converge. That version fragmented every line
    at its wider word gaps — mean box width stuck around 35% of the page
    however the gap kernel was tuned — and its greedy merge step grew a
    box until it overlapped the next line and swallowed that too. A
    projection profile has no such parameter to tune: a line of text IS
    a run of rows containing ink, and the gap between lines IS the
    valley between them.

    It assumes the page is roughly horizontal, which after the
    perspective and deskew stages it is. A heavily rotated page would
    smear the profile flat, and the empty result that produces is the
    honest answer rather than a wrong one.
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
    ink = _strip_border(ink)

    # Ink pixels per row, smoothed so a gap between two words on the
    # same row does not read as a valley.
    profile = (ink > 0).sum(axis=1).astype(np.float32)
    window = max(3, int(short * 0.004) | 1)
    kernel = np.ones(window, dtype=np.float32) / window
    profile = np.convolve(profile, kernel, mode="same")

    if profile.max() <= 0:
        return []
    # A row belongs to a line when it carries a real share of the ink of
    # the busiest row. Relative, so it holds for a dense page and a
    # sparse one alike.
    floor = profile.max() * ROW_INK_FRACTION

    min_h = short * MIN_LINE_HEIGHT_FRAC
    max_h = short * MAX_LINE_HEIGHT_FRAC
    min_w = w * MIN_LINE_WIDTH_FRAC

    boxes: list[tuple[int, int, int, int]] = []
    y = 0
    while y < h:
        if profile[y] <= floor:
            y += 1
            continue
        start_row = y
        while y < h and profile[y] > floor:
            y += 1
        band_h = y - start_row
        if band_h < min_h or band_h > max_h:
            continue
        # Horizontal extent: the columns of this band that carry ink.
        band = ink[start_row:y, :]
        cols = np.where((band > 0).any(axis=0))[0]
        if cols.size == 0:
            continue
        x0, x1 = int(cols[0]), int(cols[-1])
        if (x1 - x0) < min_w:
            continue
        boxes.append((x0, start_row, x1 - x0, band_h))

    return boxes


def _strip_border(ink: Any) -> Any:
    """Erase ink touching the frame edge.

    These photos have a dark page edge that thresholds to a solid band
    down one or both sides. Left in, it puts ink in every single row and
    the projection profile never reaches a valley, so the whole page
    reads as one line.
    """
    h, w = ink.shape[:2]
    margin = max(2, int(min(h, w) * 0.012))
    out = ink.copy()
    out[:margin, :] = 0
    out[-margin:, :] = 0
    out[:, :margin] = 0
    out[:, -margin:] = 0
    return out


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
