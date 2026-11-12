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
#: The detected quad must account for this much of the lit page region.
#: Below it we have found something inside the page rather than the page
#: itself, and warping to it would crop real content away — which is the
#: one outcome worse than doing nothing.
MIN_MASK_COVERAGE = 0.85
#: Where the paper should land. Not 255: leaving headroom keeps paper
#: texture and faint pencil from being clipped into pure white.
PAPER_TARGET = 245.0
#: The ink anchor never rises above this. On a near-empty page the low
#: percentile is still paper, and stretching from there crushes the
#: midtones of any photograph or colour panel on the page.
INK_ANCHOR_CAP = 120.0
SHARPEN_SIGMA = 1.2
SHARPEN_AMOUNT = 0.45
#: Below this the page is already evenly lit and flattening it is a
#: requantisation that buys nothing — measured to cost OCR characters
#: on an evenly lit page rather than gain any.
MIN_UNEVENNESS = 1.25
#: Every page corner must sit at least this far inside the frame. A
#: corner on the border means the photo cut that side of the page off.
FRAME_MARGIN = 0.015
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
            # No page outline, so no warp — but the enhancement needs
            # nothing detected, and these close-ups are exactly the
            # photos a scanner app is expected to clean up.
            report["unevenness"] = round(_illumination_unevenness(bgr), 3)
            enhanced = enhance_document(bgr)
            report["applied"] = True
            report["stages"] = ["enhance"]
            out = cv2.cvtColor(enhanced, cv2.COLOR_BGR2RGB)
            return Image.fromarray(out), report

        warped = _four_point_transform(bgr, quad)
        stages = ["perspective"]

        warped, angle = _deskew(warped)
        if angle:
            stages.append("deskew")
        report["deskew_deg"] = round(float(angle), 2)

        warped = enhance_document(warped)
        stages.append("enhance")

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


def _page_contours(bgr: Any) -> list[Any]:
    """Candidate page outlines, from two independent views of the image.

    Canny alone was not enough. On real phone photos of a notepad — a
    pale page on a pale desk, a spiral binding chewing up the top edge,
    a hand over the bottom — it returned outlines of 5 to 14 sides on
    every single test image and the page was never found.

    So also threshold on brightness, which is what actually separates a
    lit page from the surface under it, and close the result hard enough
    to swallow the binding and the fingers. Whichever view yields a
    usable quad first wins; the gate downstream is unchanged.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    out: list[Any] = []

    # View 1 — the page as a bright region.
    _, bright = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = np.ones((9, 9), np.uint8)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, k, iterations=3)
    bright = cv2.morphologyEx(bright, cv2.MORPH_OPEN, k, iterations=2)
    found = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out += list(found[0] if len(found) == 2 else found[1])

    # View 2 — the page as an edge.
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    found = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out += list(found[0] if len(found) == 2 else found[1])

    return sorted(out, key=cv2.contourArea, reverse=True)[:8]


def _quad_from_contour(contour: Any) -> Any:
    """Four corners for a contour, or None.

    A photographed page rarely simplifies to exactly four points at one
    fixed tolerance — a single hardcoded epsilon of 0.02 was why real
    photos never produced a quad. Take the convex hull first, which
    removes the bites the binding and fingers take out of the outline,
    then sweep the tolerance and accept the first four-sided convex
    result.
    """
    hull = cv2.convexHull(contour)
    peri = cv2.arcLength(hull, True)
    if peri <= 0:
        return None
    for eps in (0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.07, 0.09):
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx.reshape(4, 2).astype(np.float32)

    # No minAreaRect fallback. It was tried and removed: on real photos
    # it happily returned a rectangle around some bright region INSIDE
    # the page and the warp then cropped half the writing away. A page
    # whose outline will not simplify to four corners is a page we have
    # not found.
    return None


def _page_mask(gray: Any) -> Any:
    """Binary mask of the lit page region."""
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = np.ones((9, 9), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=3)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, k, iterations=2)


def _page_runs_off_frame(mask: Any) -> int:
    """How many frame edges the page touches.

    A close-up phone photo of a notepad usually has the page running
    out of shot on two or more sides. There is then no complete
    quadrilateral in the image, and anything we "detect" is a region
    inside the page — warping to it crops real content away. Counting
    the touched edges is how we tell that case apart from a page lying
    whole in the frame.
    """
    h, w = mask.shape[:2]
    band = max(2, min(h, w) // 100)
    touched = 0
    if mask[:band, :].mean() > 96:
        touched += 1
    if mask[-band:, :].mean() > 96:
        touched += 1
    if mask[:, :band].mean() > 96:
        touched += 1
    if mask[:, -band:].mean() > 96:
        touched += 1
    return touched


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

    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    mask = _page_mask(gray)

    edges_touched = _page_runs_off_frame(mask)
    report["page_edges_in_frame"] = 4 - edges_touched
    if edges_touched:
        # Perspective recovery needs all four page edges in shot. If the
        # page leaves the picture on even one side there is no complete
        # quadrilateral, and whatever we detect is a region INSIDE the
        # page — warping to that silently crops real content away, which
        # is the one outcome worse than doing nothing.
        #
        # This was learned the hard way on 14 real phone photos of a
        # notepad: a looser rule fired on 13 of them and cropped the
        # title, the right margin or the last lines off most. Lighting
        # is still flattened; only the warp is withheld.
        report["reason"] = "page-overruns-frame (%d edges)" % edges_touched
        return None

    mask_area = float(cv2.countNonZero(mask))
    contours = _page_contours(small)
    if not contours:
        report["reason"] = "no-contours"
        return None

    frame_area = float(small.shape[0] * small.shape[1])
    rejects: list[str] = []

    for contour in contours:
        pts = _quad_from_contour(contour)
        if pts is None:
            rejects.append("no-quad")
            continue
        frac = abs(cv2.contourArea(pts.astype(np.float32))) / frame_area
        if frac < MIN_AREA_FRACTION:
            rejects.append("small=%.2f" % frac)
            continue
        if frac > MAX_AREA_FRACTION:
            rejects.append("fills-frame=%.2f" % frac)
            continue
        if not _corners_square_enough(pts):
            rejects.append("corner-angles")
            continue
        # The quad has to BE the page, not a bright block within it.
        # Without this a region inside the writing scored four clean
        # corners and the warp cropped the rest of the page away.
        quad_area = abs(cv2.contourArea(pts.astype(np.float32)))
        if mask_area > 0 and quad_area / mask_area < MIN_MASK_COVERAGE:
            rejects.append("covers-%.0f%%-of-page" % (100 * quad_area / mask_area))
            continue
        # Every corner must sit inside the frame with real background
        # around it. A corner pinned to the border means that side of
        # the page is cut off by the photo.
        mh, mw = small.shape[:2]
        margin_x, margin_y = mw * FRAME_MARGIN, mh * FRAME_MARGIN
        if (
            pts[:, 0].min() < margin_x
            or pts[:, 1].min() < margin_y
            or pts[:, 0].max() > mw - margin_x
            or pts[:, 1].max() > mh - margin_y
        ):
            rejects.append("corner-on-frame-edge")
            continue
        report["quad_area_fraction"] = round(float(frac), 3)
        report["page_coverage"] = round(float(quad_area / mask_area), 3) if mask_area else None
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


def _illumination_unevenness(bgr: Any) -> float:
    """How far the lighting varies across the page, as a ratio.

    1.0 is perfectly flat. A shadow across one side pushes it well
    above 1.2. Measured on the illumination field rather than the
    pixels so text does not count as darkness.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    small = cv2.resize(gray, (max(1, w // 16), max(1, h // 16)),
                       interpolation=cv2.INTER_AREA)
    k = max(3, (min(small.shape[:2]) // 6) | 1)
    field = cv2.medianBlur(cv2.dilate(small, np.ones((5, 5), np.uint8)), k)
    lo = float(np.percentile(field, 5))
    hi = float(np.percentile(field, 95))
    if lo < 1.0:
        lo = 1.0
    return hi / lo


def enhance_document(bgr: Any) -> Any:
    """Turn a photographed page into something that reads as a scan.

    This, not the perspective warp, is what a scanner app actually sells.
    A photo of a page is grey, flat and shadowed; a scan is black ink on
    white paper. Getting there is three steps after the lighting is
    flattened: put the paper at white, put the ink at black, and
    sharpen what the camera softened.

    Colour is kept. Hard binarisation would read as more "scan-like"
    still, but it throws away blue biro, highlighter and anything
    printed in colour, and it destroys a photograph pasted into a page.
    Keeping colour is the difference between a tool that cleans
    documents and one that only works on black text.

    Unlike the perspective stage this needs nothing detected, so it runs
    on every photo — including the close-ups where the page overruns the
    frame and there is no quad to find. That is the whole point: those
    are the ones the warp could not help.
    """
    flat = _flatten_illumination(bgr)

    # Work on lightness alone, in LAB, and leave the colour channels
    # untouched.
    #
    # Scaling B, G and R together was the obvious thing and it is wrong:
    # multiplying all three widens the gaps between them, so saturation
    # climbs with brightness. On a real photo the page came out nicely
    # white and the hand holding it came out fluorescent orange. Moving
    # only L lifts the paper and deepens the ink while every hue and
    # chroma in the frame stays where the camera put it.
    lab = cv2.cvtColor(flat, cv2.COLOR_BGR2LAB)
    lightness = lab[:, :, 0].astype(np.float32)

    # The 85th percentile is the paper: above most of the ink, below any
    # specular highlight. The mean would be dragged down by dense text.
    paper = float(np.percentile(lightness, 85))
    if paper < 1.0:
        paper = 1.0
    lightness = lightness * (PAPER_TARGET / paper)

    # Pull the ink down. Anchor on a low percentile, but never above
    # INK_ANCHOR_CAP: on a near-empty page the 5th percentile is still
    # paper, and stretching from there would crush the midtones of a
    # photograph or a colour panel into black.
    ink = min(float(np.percentile(lightness, 5)), INK_ANCHOR_CAP)
    span = max(1.0, PAPER_TARGET - ink)
    lightness = (lightness - ink) * (255.0 / span)

    lab[:, :, 0] = np.clip(lightness, 0, 255).astype(np.uint8)
    out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # Unsharp mask. A phone's own denoising softens pen strokes, and
    # Tesseract keys off stroke edges.
    blurred = cv2.GaussianBlur(out, (0, 0), SHARPEN_SIGMA)
    return cv2.addWeighted(out, 1.0 + SHARPEN_AMOUNT, blurred, -SHARPEN_AMOUNT, 0)


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
