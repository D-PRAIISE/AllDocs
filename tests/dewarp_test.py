"""Dewarp regression test.

Builds a synthetic "phone photo" of a page — perspective, tilt and a
shadow across one side — from text we know, then measures how much of
that text Tesseract recovers with and without the correction.

Character error rate, not eyeballing: "it looks better" is not a result
you can regress against.

Also pins the gate, which matters more than the improvement. Detecting
the wrong quad crops real content away silently, so the test asserts
that an already-cropped page (what a scanner app hands us) is NOT
perspective-corrected, and that a photo of a desk with no page in it is
left alone.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "pdf-adapter" / "src"))

from pdf_adapter import _dewarp, _ocr  # noqa: E402

TRUTH = [
    "NATIONAL YOUTH TRAINING MANUAL",
    "The Ministry of the Gatekeepers in the Church",
    "can be understood from both biblical and",
    "practical perspectives. A gatekeeper in the Old",
    "Testament was one who watched over the gates,",
    "ensured order and protected sacred spaces.",
    "Youths are not to destroy the foundation.",
]


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def normalise(s: str) -> str:
    return " ".join(s.split()).upper()


def cer(got: str, truth: str) -> float:
    g, t = normalise(got), normalise(truth)
    return levenshtein(g, t) / max(len(t), 1)


def clean_page():
    """A flat, evenly lit page — what a scan looks like."""
    from PIL import Image, ImageDraw, ImageFont

    W, H = 1240, 1754
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", 38)
    except Exception:
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 38)
        except Exception:
            font = ImageFont.load_default()
    y = 220
    for line in TRUTH:
        d.text((110, y), line, fill=(10, 10, 10), font=font)
        y += 72
    return im


def photograph(page):
    """Warp the page onto a desk, tilt it, and light it unevenly."""
    import cv2
    import numpy as np

    page_bgr = cv2.cvtColor(np.array(page), cv2.COLOR_RGB2BGR)
    ph, pw = page_bgr.shape[:2]

    # a desk, larger than the page
    cw, chh = int(pw * 1.45), int(ph * 1.3)
    canvas = np.full((chh, cw, 3), 90, dtype=np.uint8)

    src = np.array([[0, 0], [pw - 1, 0], [pw - 1, ph - 1], [0, ph - 1]], dtype=np.float32)
    # a plausible hand-held angle: nearer edge wider, slight rotation
    dst = np.array(
        [
            [cw * 0.18, chh * 0.10],
            [cw * 0.86, chh * 0.16],
            [cw * 0.80, chh * 0.92],
            [cw * 0.11, chh * 0.84],
        ],
        dtype=np.float32,
    )
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(
        page_bgr, m, (cw, chh), borderMode=cv2.BORDER_CONSTANT, borderValue=(90, 90, 90)
    )

    # a shadow falling across the left third
    grad = np.linspace(0.45, 1.15, cw, dtype=np.float32)
    grad = np.clip(grad, 0, 1.2)[None, :, None]
    lit = np.clip(warped.astype(np.float32) * grad, 0, 255).astype(np.uint8)
    from PIL import Image

    return Image.fromarray(cv2.cvtColor(lit, cv2.COLOR_BGR2RGB))


def ocr_text(pil_img) -> str:
    """Go through the adapter's own OCR path, not pytesseract directly.

    _ocr resolves the tesseract binary itself (PATH, then the standard
    Windows install location) and sets TESSDATA_PREFIX. Calling
    pytesseract raw skips all of that and fails on any machine where
    tesseract is not already on PATH — including this one.
    """
    result = _ocr.ocr_image(pil_img, granularity="line")
    runs = getattr(result, "runs", None)
    if runs is None and isinstance(result, dict):
        runs = result.get("runs")
    return " ".join((r.get("text") if isinstance(r, dict) else getattr(r, "text", "")) or ""
                    for r in (runs or []))


def main() -> int:
    print("Dewarp (scanner-style correction) test")
    print()

    if not _dewarp.available():
        print("  [SKIP] OpenCV not available")
        return 0
    if not _ocr.tesseract_available():
        print("  [SKIP] Tesseract not available")
        return 0

    truth = " ".join(TRUTH)
    failures = 0

    # --- the improvement ------------------------------------------------
    page = clean_page()
    photo = photograph(page)

    before = cer(ocr_text(photo), truth)
    fixed, report = _dewarp.dewarp_image(photo)
    after = cer(ocr_text(fixed), truth)

    print("  photo CER before : %.3f" % before)
    print("  photo CER after  : %.3f" % after)
    print("  report           : %s" % {k: report[k] for k in ("applied", "reason", "stages") if k in report})

    if not report.get("applied"):
        print("  [FAIL] correction did not run on a clearly warped photo")
        failures += 1
    elif "perspective" not in (report.get("stages") or []):
        print("  [FAIL] perspective stage did not run: %s" % report.get("reason"))
        failures += 1
    elif after > before:
        print("  [FAIL] correction made OCR worse (%.3f -> %.3f)" % (before, after))
        failures += 1
    else:
        print("  [PASS] correction improved or held OCR accuracy")

    # --- the gate: an already-cropped page must not be re-cropped -------
    _, flat_report = _dewarp.dewarp_image(page)
    stages = flat_report.get("stages") or []
    if "perspective" in stages:
        print("  [FAIL] perspective applied to an already-flat page: %s" % flat_report)
        failures += 1
    else:
        print("  [PASS] flat page left un-warped (%s)" % flat_report.get("reason"))

    # --- the gate: no page in frame -------------------------------------
    from PIL import Image

    desk = Image.new("RGB", (900, 700), (90, 90, 90))
    _, desk_report = _dewarp.dewarp_image(desk)
    if "perspective" in (desk_report.get("stages") or []):
        print("  [FAIL] perspective applied to an image with no page: %s" % desk_report)
        failures += 1
    else:
        print("  [PASS] no-page image left un-warped (%s)" % desk_report.get("reason"))

    # --- never return a broken image ------------------------------------
    out, _ = _dewarp.dewarp_image(photo)
    if out is None or out.size[0] < 10 or out.size[1] < 10:
        print("  [FAIL] returned an unusable image")
        failures += 1
    else:
        print("  [PASS] output image is usable (%dx%d)" % out.size)

    print()
    print("  %d failure(s)" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
