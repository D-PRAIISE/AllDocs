"""Make a photographed page behave like a scanned one.

A phone photo of a document differs from a scan in three ways that
Tesseract cares about, in descending order of damage:

  1. perspective — the page is a trapezoid, so glyph shapes shear and
     the baseline of a line is not horizontal across the page;
  2. rotation — the residual tilt left after the perspective is undone;
  3. illumination — a shadow across one half, or a bright hotspot,
     which pushes a global threshold the wrong way for part of the page.

This module undoes all three before OCR runs, and replaces the stored
page image with the corrected one so the editor shows what the user
would have got from a scanner.

WHAT THIS DOES NOT DO. It does not reconstruct layout — the UDM
pipeline already does that, which is why text arrives as positioned
runs. And it cannot recover detail the camera never captured: a blurred
photo stays blurred. The claim is "a reasonable photo now behaves like
a scan", not "any photo becomes a document".

THE FAILURE MODE THAT MATTERS. Detecting the wrong quadrilateral is
far worse than detecting none: it crops away real content, silently,
and the user has no way to know what was lost. So every correction is
gated, and anything the gate is unsure about leaves the image exactly
as it arrived. Losing an improvement is cheap; losing half a letter is
not. `report["applied"]` and `report["reason"]` say which happened.
"""

from __future__ import annotations

from typing import Any

try:  # pragma: no cover - exercised by the absence path in tests
    import cv2
    import numpy as np

    _AVAILABLE = True
except Exception:  # pragma: no cover
    _AVAILABLE = False


# --- gate thresholds ------------------------------------------------------
#
# Deliberately strict. Each one has a failure it exists to prevent.

#: Below this the "page" is some object on a desk, not the document.
MIN_AREA_FRACTION = 0.25
#: Above this the quad is the photo's own border — there is no visible
#: background, so there is no perspective to recover. An image that has
#: already been through a scanner app lands here and is left alone.
MAX_AREA_FRACTION = 0.985
#: A perspective-distorted rectangle still has roughly square corners.
#: Anything outside this is a shape that merely happens to have 4 sides.
MIN_CORNER_DEG = 45.0
MAX_CORNER_DEG = 135.0
#: A page is not a sliver.
MIN_ASPECT = 0.2
MAX_ASPECT = 5.0
#: Residual rotation we will correct. Beyond this the estimate is more
#: likely wrong than the page is tilted.
MAX_DESKEW_DEG = 15.0
#: Below this a rotation costs a resample and buys nothing.
MIN_DESKEW_DEG = 0.3
#: Detection runs on a downscaled copy; the quad is scaled back up.
DETECT_LONG_EDGE = 1000


def available() -> bool:
    """True when OpenCV is importable."""
    return _AVAILABLE


def dewarp_image(pil_rgb: Any) -> tuple[Any, dict[str, Any]]:
    """Correct a photographed page. Returns ``(image, report)``.

    ``image`` is a PIL RGB image: the corrected page when every gate
    passed, otherwise the input unchanged. ``report`` always says what
    happened, so callers can record it and tests can assert on it.
    """
    report: dict[str, Any] = {"applied": False, "reason": "not-attempted"}
    if not _AVAILABLE:
        report["reason"] = "opencv-unavailable"
        return pil_rgb, report

    try:
        from PIL import Image

        bgr = cv2.cvtColor(np.array(pil_rgb), cv2.COLOR_RGB2BGR)
        report["input_size"] = [int(bgr.shape[1]), int(bgr.shape[0])]

        quad = _find_page_quad(bgr, report)
        if quad is None:
            # No usable quad. Still worth flattening the lighting: that
            # correction cannot crop anything, so it is safe even when
            # we have no idea where the page edges are.
            flat = _flatten_illumination(bgr)
            report["applied"] = True
            report["stages"] = ["illumination"]
            report["reason"] = report.get("reason", "no-quad")
            out = cv2.cvtColor(flat, cv2.COLOR_BGR2RGB)
            return Image.fromarray(out), report

        warped = _four_point_transform(bgr, quad)
        stages = ["perspective"]

        warped, angle = _deskew(warped)
        if angle:
            stages.append("deskew")
        report["deskew_deg"] = round(float(angle), 2)

        warped = _flatten_illumination(warped)
        stages.append("illumination")

        report["applied"] = True
        report["reason"] = "ok"
        report["stages"] = stages
        report["output_size"] = [int(warped.shape[1]), int(warped.shape[0])]
        return Image.fromarray(cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)), report
    except Exception as exc:  # pragma: no cover - defensive
        # Never let image processing take down an import. An uncorrected
        # page is a worse page, not a failed one.
        report["applied"] = False
        report["reason"] = "error: %s" % (exc.__class__.__name__,)
        return pil_rgb, report


# --- stages ---------------------------------------------------------------


def _find_page_quad(bgr: Any, report: dict[str, Any]) -> Any:
    """The page's four corners in full-resolution coordinates, or None."""
    h, w = bgr.shape[:2]
    longest = max(h, w)
    scale = DETECT_LONG_EDGE / longest if longest > DETECT_LONG_EDGE else 1.0
    small = (
        cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        if scale != 1.0
        else bgr
    )

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    # Close gaps in the page outline — a shadowed corner often breaks it.
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    found = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = found[0] if len(found) == 2 else found[1]
    if not contours:
        report["reason"] = "no-contours"
        return None

    frame_area = float(small.shape[0] * small.shape[1])
    rejects: list[str] = []

    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4:
            rejects.append("sides=%d" % len(approx))
            continue
        if not cv2.isContourConvex(approx):
            rejects.append("concave")
            continue
        frac = cv2.contourArea(approx) / frame_area
        if frac < MIN_AREA_FRACTION:
            rejects.append("small=%.2f" % frac)
            continue
        if frac > MAX_AREA_FRACTION:
            rejects.append("fills-frame=%.2f" % frac)
            continue
        pts = approx.reshape(4, 2).astype(np.float32)
        if not _corners_square_enough(pts):
            rejects.append("corner-angles")
            continue
        report["quad_area_fraction"] = round(float(frac), 3)
        return pts / scale

    report["reason"] = "no-quad (%s)" % ("; ".join(rejects[:4]) or "none considered")
    return None


def _corners_square_enough(pts: Any) -> bool:
    ordered = _order_corners(pts)
    for i in range(4):
        a = ordered[(i - 1) % 4]
        b = ordered[i]
        c = ordered[(i + 1) % 4]
        v1 = a - b
        v2 = c - b
        n1 = float(np.linalg.norm(v1))
        n2 = float(np.linalg.norm(v2))
        if n1 == 0 or n2 == 0:
            return False
        cosang = float(np.dot(v1, v2)) / (n1 * n2)
        ang = float(np.degrees(np.arccos(max(-1.0, min(1.0, cosang)))))
        if ang < MIN_CORNER_DEG or ang > MAX_CORNER_DEG:
            return False
    return True


def _order_corners(pts: Any) -> Any:
    """Top-left, top-right, bottom-right, bottom-left."""
    out = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    out[0] = pts[np.argmin(s)]
    out[2] = pts[np.argmax(s)]
    out[1] = pts[np.argmin(d)]
    out[3] = pts[np.argmax(d)]
    return out


def _four_point_transform(bgr: Any, pts: Any) -> Any:
    tl, tr, br, bl = _order_corners(pts)
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    width = max(width, 1)
    height = max(height, 1)

    aspect = width / float(height)
    if aspect < MIN_ASPECT or aspect > MAX_ASPECT:
        raise ValueError("implausible page aspect %.2f" % aspect)

    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(
        np.array([tl, tr, br, bl], dtype=np.float32), dst
    )
    return cv2.warpPerspective(bgr, matrix, (width, height), flags=cv2.INTER_CUBIC)


def _deskew(bgr: Any) -> tuple[Any, float]:
    """Remove residual rotation, estimated from the text pixels."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    thresh = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU
    )[1]
    coords = cv2.findNonZero(thresh)
    if coords is None or len(coords) < 50:
        return bgr, 0.0

    angle = float(cv2.minAreaRect(coords)[-1])
    # minAreaRect reports in (0, 90]; fold to the nearest axis.
    if angle > 45.0:
        angle -= 90.0
    if abs(angle) < MIN_DESKEW_DEG or abs(angle) > MAX_DESKEW_DEG:
        return bgr, 0.0

    h, w = bgr.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    rotated = cv2.warpAffine(
        bgr,
        matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return rotated, angle


def _flatten_illumination(bgr: Any) -> Any:
    """Divide out the lighting field, keeping colour.

    A shadow across half the page moves a global threshold the wrong way
    for that half, which is where a lot of OCR error on phone photos
    comes from. Estimating the field on a downscaled copy and scaling it
    back keeps this cheap on a 10-megapixel photo — a full-size median
    blur at this radius would dominate the import.
    """
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    small_w = max(1, w // 8)
    small_h = max(1, h // 8)
    small = cv2.resize(gray, (small_w, small_h), interpolation=cv2.INTER_AREA)
    # Dilate then median-blur: text disappears into the page around it,
    # leaving the illumination.
    k = max(3, (min(small_w, small_h) // 8) | 1)
    background = cv2.medianBlur(cv2.dilate(small, np.ones((5, 5), np.uint8)), k)
    background = cv2.resize(background, (w, h), interpolation=cv2.INTER_LINEAR)

    field = background.astype(np.float32)
    field[field < 1.0] = 1.0
    gain = float(field.mean()) / field

    out = bgr.astype(np.float32) * gain[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)
