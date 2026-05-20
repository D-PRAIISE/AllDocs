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


def ocr_page(page: pymupdf.Page, dpi: int = OCR_DPI) -> OcrResult:
    """Render ``page`` and OCR it. Returns line-level runs in PDF points.

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
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)

    scale = 72.0 / dpi  # pixels -> points

    # Group word tokens by (block, paragraph, line).
    lines: dict[tuple[int, int, int], list[int]] = {}
    n = len(data["text"])
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

    runs: list[OcrRun] = []
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

        color = _sample_color(img, (px0 + px1) // 2, (py0 + py1) // 2)

        runs.append(
            OcrRun(
                text=" ".join(words),
                x0=px0 * scale,
                y0=py0 * scale,
                x1=px1 * scale,
                y1=py1 * scale,
                confidence=round(sum(confs) / len(confs) / 100.0, 4),
                color=color,
            )
        )

    return OcrResult(runs=runs, engine=_ENGINE_NAME)


def _sample_color(img: Any, x: int, y: int) -> tuple[int, int, int]:
    """Sample the rendered-page color at (x, y). Used as the OCR run's
    text color so white-on-dark text doesn't render as invisible black.

    This samples the *line centroid*, which usually lands on a glyph or
    in the gap between glyphs — close enough to pick text vs background
    for the common case. A v0.2 improvement would sample the darkest
    pixel in the line box to bias toward the ink color.
    """
    try:
        w, h = img.size
        px = img.getpixel((max(0, min(w - 1, x)), max(0, min(h - 1, y))))
        if isinstance(px, tuple) and len(px) >= 3:
            return (int(px[0]), int(px[1]), int(px[2]))
    except Exception:
        pass
    return (0, 0, 0)
