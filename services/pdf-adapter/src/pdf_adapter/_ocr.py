"""
OCR support for scanned / rasterized PDF pages.

Many real PDFs have no extractable text — the whole page is a single
raster image (a phone photo of a document, a scan, or a design tool
that flattened everything to pixels, like the Canva CV export). The
text is visible to a human but there is no text data to click or edit.

This module:
  1. detects such pages (``is_scanned_page``)
  2. runs OCR on them (``ocr_page``) and returns line-level text runs
     with bounding boxes, a confidence score, and a sampled color

The importer turns those runs into a UDM TextLayer where every run
carries an ``ocr`` marker. The editor then makes them clickable just
like native text.

OCR engine: Tesseract via pytesseract. Tesseract is a system binary;
on Windows the UB-Mannheim build installs to a well-known path which
we auto-detect. In a Linux container it is expected on PATH.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pymupdf

# Render DPI for OCR. 200 is the sweet spot: Tesseract's processing time
# scales super-linearly with image size, so 300 DPI is ~3.5x slower than
# 200 (23s vs 6s on an A4 page) while recognizing *fewer* good words —
# the larger raster doesn't help and the extra pixels just cost time.
OCR_DPI = 200

# Words below this Tesseract confidence are dropped. The decorative /
# photographic regions of a design document produce low-confidence
# garbage tokens; 60 cleanly separates real text from noise in testing.
MIN_WORD_CONFIDENCE = 60

# A page is treated as "scanned" if image layers cover at least this
# fraction of it AND it has fewer than _MAX_NATIVE_CHARS characters of
# real extractable text.
_MIN_IMAGE_COVERAGE = 0.8
_MAX_NATIVE_CHARS = 20

_ENGINE_NAME = "tesseract"


@dataclass
class OcrRun:
    """One OCR'd line of text, ready to become a UDM PositionedTextRun."""

    text: str
    # Bounding box in PDF points.
    x0: float
    y0: float
    x1: float
    y1: float
    # 0..1 mean word confidence for the line.
    confidence: float
    # 0..255 RGB sampled from the rendered page at the line centroid.
    color: tuple[int, int, int] = (0, 0, 0)
    # 0..255 RGB of the page background around the line. The OCR-edit
    # exporter paints this over the old pixels before drawing new text.
    bg_color: tuple[int, int, int] = (255, 255, 255)

    @property
    def font_size(self) -> float:
        """Estimated font size in points from the line height."""
        return max(1.0, self.y1 - self.y0)


@dataclass
class OcrResult:
    runs: list[OcrRun] = field(default_factory=list)
    engine: str = _ENGINE_NAME


def tesseract_available() -> bool:
    """True if a Tesseract binary can be located."""
    return _locate_tesseract() is not None


def _locate_tesseract() -> str | None:
    """Find the tesseract executable. PATH first, then the standard
    Windows (UB-Mannheim) install location."""
    on_path = shutil.which("tesseract")
    if on_path:
        return on_path
    windows_default = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    if windows_default.exists():
        return str(windows_default)
    return None


def is_scanned_page(page: pymupdf.Page) -> bool:
    """Heuristic: True if the page is effectively a flat image with no
    usable text — i.e. an OCR candidate.

    Criteria: image XObjects cover >= 80% of the page area AND the page
    yields < 20 characters of native extractable text.
    """
    native_text = page.get_text("text") or ""
    if len(native_text.strip()) >= _MAX_NATIVE_CHARS:
        return False

    page_area = abs(page.rect.width * page.rect.height)
    if page_area <= 0:
        return False

    covered = 0.0
    for img in page.get_images(full=True):
        xref = img[0]
        for rect in page.get_image_rects(xref):
            covered += abs(rect.width * rect.height)
    return (covered / page_area) >= _MIN_IMAGE_COVERAGE


def ocr_page(
    page: pymupdf.Page,
    dpi: int = OCR_DPI,
    lang: str | None = None,
    granularity: str = "line",
) -> OcrResult:
    """Render ``page`` and OCR it. Returns runs in PDF points.

    ``lang`` is a Tesseract language spec ("eng", "chi_sim", "jpn",
    "eng+chi_sim", …). None defaults to Tesseract's own default (eng).
    The language pack must be installed (tessdata dir next to the
    binary); unknown languages raise from pytesseract.

    ``granularity`` is "line" (default — one run per OCR'd line) or
    "word" (one run per token). Word granularity lets the editor
    redact + replace a single word without disturbing the rest of
    the line.

    Raises RuntimeError if Tesseract or pytesseract is unavailable —
    callers should check ``tesseract_available()`` first if they want
    to degrade gracefully.
    """
    tess = _locate_tesseract()
    if tess is None:
        raise RuntimeError("Tesseract binary not found (install it or add it to PATH)")

    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:  # pragma: no cover - environment issue
        raise RuntimeError(f"pytesseract / Pillow not installed: {e}") from e

    pytesseract.pytesseract.tesseract_cmd = tess

    # When the importer runs as a subprocess (the web /api/import route),
    # TESSDATA_PREFIX usually isn't inherited. Point it at the tessdata
    # dir next to the binary so language data is always found.
    if "TESSDATA_PREFIX" not in os.environ:
        tessdata = Path(tess).parent / "tessdata"
        if tessdata.is_dir():
            os.environ["TESSDATA_PREFIX"] = str(tessdata)

    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    kwargs: dict[str, Any] = {"output_type": pytesseract.Output.DICT}
    if lang:
        kwargs["lang"] = lang
    data = pytesseract.image_to_data(img, **kwargs)

    scale = 72.0 / dpi  # pixels -> points

    runs: list[OcrRun] = []
    n = len(data["text"])

    if granularity == "word":
        # One run per OCR token. Skip empties + low-confidence garbage.
        for i in range(n):
            text = (data["text"][i] or "").strip()
            if not text:
                continue
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError):
                conf = -1.0
            if conf < MIN_WORD_CONFIDENCE:
                continue
            px0 = int(data["left"][i])
            py0 = int(data["top"][i])
            px1 = px0 + int(data["width"][i])
            py1 = py0 + int(data["height"][i])
            bg = _sample_background(img, px0, py0, px1, py1)
            color = _sample_ink_color(img, px0, py0, px1, py1, bg)
            runs.append(
                OcrRun(
                    text=text,
                    x0=px0 * scale,
                    y0=py0 * scale,
                    x1=px1 * scale,
                    y1=py1 * scale,
                    confidence=round(conf / 100.0, 4),
                    color=color,
                    bg_color=bg,
                )
            )
        return OcrResult(runs=runs, engine=_ENGINE_NAME)

    # Line granularity (default): group word tokens by (block, par, line).
    lines: dict[tuple[int, int, int], list[int]] = {}
    for i in range(n):
        text = (data["text"][i] or "").strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if conf < MIN_WORD_CONFIDENCE:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(i)

    for key in sorted(lines.keys()):
        idxs = sorted(lines[key], key=lambda i: data["word_num"][i])
        words = [data["text"][i].strip() for i in idxs]
        confs = [float(data["conf"][i]) for i in idxs]

        lefts = [data["left"][i] for i in idxs]
        tops = [data["top"][i] for i in idxs]
        rights = [data["left"][i] + data["width"][i] for i in idxs]
        bottoms = [data["top"][i] + data["height"][i] for i in idxs]

        px0, py0 = min(lefts), min(tops)
        px1, py1 = max(rights), max(bottoms)

        # Background first — the ink color is then derived as the dominant
        # color in the line box that is *not* close to the background.
        bg = _sample_background(img, px0, py0, px1, py1)
        color = _sample_ink_color(img, px0, py0, px1, py1, bg)

        runs.append(
            OcrRun(
                text=" ".join(words),
                x0=px0 * scale,
                y0=py0 * scale,
                x1=px1 * scale,
                y1=py1 * scale,
                confidence=round(sum(confs) / len(confs) / 100.0, 4),
                color=color,
                bg_color=bg,
            )
        )

    return OcrResult(runs=runs, engine=_ENGINE_NAME)


def _color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _sample_ink_color(
    img: Any,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    bg: tuple[int, int, int],
) -> tuple[int, int, int]:
    """Derive the text (ink) color of an OCR'd line.

    A single centroid pixel is unreliable — it often lands in the gap
    between glyphs and picks up the background (which is how white text
    on a dark sidebar got sampled as dark, making edited text render
    invisible). Instead: scan the line box, discard pixels close to the
    background color, and return the most common color among the rest —
    that's the ink.
    """
    try:
        w, h = img.size
        # Distance beyond which a pixel counts as "ink" rather than
        # background. ~60 in RGB space cleanly separates glyph pixels
        # from background + anti-aliasing fringe.
        ink_threshold = 60.0
        counts: dict[tuple[int, int, int], int] = {}
        step = max(1, (x1 - x0) // 96)
        for sx in range(max(0, x0), min(w, x1), step):
            for sy in range(max(0, y0), min(h, y1)):
                px = img.getpixel((sx, sy))
                if not (isinstance(px, tuple) and len(px) >= 3):
                    continue
                key = (int(px[0]), int(px[1]), int(px[2]))
                if _color_distance(key, bg) >= ink_threshold:
                    counts[key] = counts.get(key, 0) + 1
        if counts:
            return max(counts.items(), key=lambda kv: kv[1])[0]
    except Exception:
        pass
    # No pixel stood out from the background — fall back to the color
    # farthest from it (black for light bg, white for dark bg).
    return (255, 255, 255) if sum(bg) < 384 else (0, 0, 0)


def _sample_background(
    img: Any, x0: int, y0: int, x1: int, y1: int
) -> tuple[int, int, int]:
    """Estimate the page background color around an OCR'd line.

    Samples a thin horizontal strip in the inter-line gap just above the
    line (falling back to just below it, then the line box itself) and
    returns the most common color. The gap between lines is reliably
    background, so its modal color is a good fill for covering the old
    text pixels when an OCR run is edited.
    """
    try:
        w, h = img.size
        line_h = max(1, y1 - y0)
        gap = max(2, line_h // 3)

        for top, bot in (
            (y0 - gap, y0 - 1),  # strip above the line
            (y1 + 1, y1 + gap),  # strip below the line
            (y0, y1),  # last resort: the line box itself
        ):
            top = max(0, top)
            bot = min(h - 1, bot)
            if bot < top:
                continue
            counts: dict[tuple[int, int, int], int] = {}
            step = max(1, (x1 - x0) // 64)
            for sx in range(max(0, x0), min(w, x1), step):
                for sy in range(top, bot + 1):
                    px = img.getpixel((sx, sy))
                    if isinstance(px, tuple) and len(px) >= 3:
                        key = (int(px[0]), int(px[1]), int(px[2]))
                        counts[key] = counts.get(key, 0) + 1
            if counts:
                return max(counts.items(), key=lambda kv: kv[1])[0]
    except Exception:
        pass
    return (255, 255, 255)
