"""
Image clip-path extraction.

PDFs frequently place an image with a large transform matrix and then
restrict what's visible with a *clip path* — e.g. a portrait whose
photo XObject is huge and off-page, clipped to a small window. The
high-level PyMuPDF APIs (get_image_rects / get_image_info / get_bboxlog)
all report the unclipped transform rectangle, so the AllDocs canvas,
which re-renders from the UDM, drew such images at full size — a photo
ballooning to cover the page.

This module walks the page content stream (recursing into Form
XObjects), tracking the CTM and the active clip, and records the clip
rectangle in effect when each image is painted. The importer attaches
it to the image layer; the renderers clip the image to it.

Scope: rectangular clips under axis-aligned matrices — the overwhelming
common case. Rotated/skewed matrices fall back to the transformed
bounding box. Anything unparseable simply yields no clip (the image
renders unclipped, as before — graceful degradation).
"""
from __future__ import annotations

import re
from typing import Any

import pymupdf

# (a, b, c, d, e, f) — PDF transform matrix.
Matrix = tuple[float, float, float, float, float, float]
_IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

_MAX_FORM_DEPTH = 8


def _mat_mul(m1: Matrix, m2: Matrix) -> Matrix:
    """Compose: apply m1 then m2 (matrix product m1 · m2)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _transform_rect(m: Matrix, x0: float, y0: float, x1: float, y1: float) -> pymupdf.Rect:
    """Transform the rect's four corners and return the bounding box."""
    pts = [
        _apply(m, x0, y0),
        _apply(m, x1, y0),
        _apply(m, x1, y1),
        _apply(m, x0, y1),
    ]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return pymupdf.Rect(min(xs), min(ys), max(xs), max(ys))


def _intersect(a: pymupdf.Rect | None, b: pymupdf.Rect | None) -> pymupdf.Rect | None:
    if a is None:
        return b
    if b is None:
        return a
    r = a & b
    return r if not (r.is_empty or r.is_infinite) else pymupdf.Rect(0, 0, 0, 0)


# ---- Tokenizer -----------------------------------------------------------

# A content-stream token: a number, a /name, or an operator. Strings,
# hex strings, dicts and arrays are skipped wholesale — none of the
# operators we care about (q Q cm re W W* n Do) take them.
_NUM_RE = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)")
_NAME_RE = re.compile(rb"/[^\s/()<>\[\]{}]*")
_OP_RE = re.compile(rb"[A-Za-z'\"*]+[01]?")


def _tokenize(data: bytes) -> list[tuple[str, Any]]:
    toks: list[tuple[str, Any]] = []
    i, n = 0, len(data)
    while i < n:
        ch = data[i]
        if ch in b" \t\r\n\f\x00":
            i += 1
            continue
        if ch == 0x25:  # % comment
            while i < n and data[i] not in b"\r\n":
                i += 1
            continue
        if ch == 0x28:  # ( string
            depth, i = 1, i + 1
            while i < n and depth:
                if data[i] == 0x5C:  # backslash escape
                    i += 2
                    continue
                if data[i] == 0x28:
                    depth += 1
                elif data[i] == 0x29:
                    depth -= 1
                i += 1
            continue
        if ch == 0x3C:  # < — hex string or << dict
            if i + 1 < n and data[i + 1] == 0x3C:
                depth, i = 1, i + 2
                while i + 1 < n and depth:
                    if data[i] == 0x3C and data[i + 1] == 0x3C:
                        depth += 1
                        i += 2
                    elif data[i] == 0x3E and data[i + 1] == 0x3E:
                        depth -= 1
                        i += 2
                    else:
                        i += 1
            else:
                while i < n and data[i] != 0x3E:
                    i += 1
                i += 1
            continue
        if ch == 0x5B:  # [ array — skip to matching ]
            depth, i = 1, i + 1
            while i < n and depth:
                if data[i] == 0x28:  # string inside array
                    depth2, i = 1, i + 1
                    while i < n and depth2:
                        if data[i] == 0x5C:
                            i += 2
                            continue
                        if data[i] == 0x28:
                            depth2 += 1
                        elif data[i] == 0x29:
                            depth2 -= 1
                        i += 1
                    continue
                if data[i] == 0x5B:
                    depth += 1
                elif data[i] == 0x5D:
                    depth -= 1
                i += 1
            continue
        if ch == 0x2F:  # /name
            m = _NAME_RE.match(data, i)
            if m:
                toks.append(("name", m.group()[1:].decode("latin-1")))
                i = m.end()
                continue
            i += 1
            continue
        m = _NUM_RE.match(data, i)
        if m:
            try:
                toks.append(("num", float(m.group())))
            except ValueError:
                pass
            i = m.end()
            continue
        m = _OP_RE.match(data, i)
        if m:
            toks.append(("op", m.group().decode("latin-1")))
            i = m.end()
            continue
        i += 1
    return toks


# ---- XObject resolution --------------------------------------------------


def _resources_xobjects(doc: pymupdf.Document, res: Any) -> dict[str, int]:
    """Map XObject /Name -> xref from a Resources value (dict text or ref)."""
    text = ""
    if isinstance(res, tuple) and len(res) > 1:
        kind, val = res[0], res[1]
        if kind == "xref":
            m = re.match(r"(\d+)", str(val))
            if m:
                try:
                    text = doc.xref_object(int(m.group(1)), compressed=True)
                except Exception:
                    text = ""
        else:
            text = str(val)
    if not text:
        return {}
    # Pull the /XObject << ... >> sub-dictionary.
    xo = re.search(r"/XObject\s*<<(.*?)>>", text, re.DOTALL)
    if not xo:
        return {}
    out: dict[str, int] = {}
    for m in re.finditer(r"/([^\s/<>]+)\s+(\d+)\s+\d+\s+R", xo.group(1)):
        out[m.group(1)] = int(m.group(2))
    return out


def _array_to_matrix(val: Any) -> Matrix | None:
    if not (isinstance(val, tuple) and len(val) > 1):
        return None
    m = re.findall(r"[+-]?(?:\d+\.?\d*|\.\d+)", str(val[1]))
    if len(m) >= 6:
        return tuple(float(x) for x in m[:6])  # type: ignore[return-value]
    return None


# ---- Interpreter ---------------------------------------------------------


def extract_image_clips(page: pymupdf.Page, doc: pymupdf.Document) -> list[dict[str, Any]]:
    """Return one entry per image painted on ``page``:

        {"xref": int, "transform": Rect, "clip": Rect | None}

    ``transform`` is where the whole image would draw; ``clip`` is the
    visible window (None = unclipped). Caller matches by xref+transform.
    """
    results: list[dict[str, Any]] = []
    try:
        content = page.read_contents()
    except Exception:
        return results
    page_res = None
    try:
        page_res = doc.xref_get_key(page.xref, "Resources")
    except Exception:
        page_res = None

    # PDF content streams use a bottom-left, y-up coordinate space;
    # PyMuPDF rects (and the importer's image placements) are top-left,
    # y-down. page.transformation_matrix is exactly the PDF->PyMuPDF
    # transform (it accounts for the MediaBox origin and page rotation),
    # so seeding the CTM with it makes every rect we compute come out
    # directly in PyMuPDF space.
    try:
        tm = page.transformation_matrix
        base: Matrix = (tm.a, tm.b, tm.c, tm.d, tm.e, tm.f)
    except Exception:
        base = (1.0, 0.0, 0.0, -1.0, 0.0, float(page.rect.height))
    _walk(doc, content, page_res, base, None, results, depth=0)
    return results


def _walk(
    doc: pymupdf.Document,
    content: bytes,
    resources: Any,
    base_ctm: Matrix,
    base_clip: pymupdf.Rect | None,
    results: list[dict[str, Any]],
    depth: int,
) -> None:
    xobjects = _resources_xobjects(doc, resources)
    toks = _tokenize(content)

    # Graphics-state stack of (ctm, clip).
    gstack: list[tuple[Matrix, pymupdf.Rect | None]] = []
    ctm: Matrix = base_ctm
    clip: pymupdf.Rect | None = base_clip
    operands: list[Any] = []
    path_rects: list[pymupdf.Rect] = []
    clip_pending = False

    for kind, val in toks:
        if kind in ("num", "name"):
            operands.append(val)
            continue
        op = val
        if op == "q":
            gstack.append((ctm, clip))
        elif op == "Q":
            if gstack:
                ctm, clip = gstack.pop()
        elif op == "cm" and len(operands) >= 6:
            m = tuple(float(x) for x in operands[-6:])
            ctm = _mat_mul(m, ctm)  # type: ignore[arg-type]
        elif op == "re" and len(operands) >= 4:
            x, y, w, h = (float(v) for v in operands[-4:])
            path_rects.append(_transform_rect(ctm, x, y, x + w, y + h))
        elif op in ("W", "W*"):
            clip_pending = True
        elif op in ("n", "f", "F", "f*", "b", "b*", "B", "B*", "s", "S"):
            if clip_pending and path_rects:
                pr = path_rects[0]
                for r in path_rects[1:]:
                    pr = pr | r  # union of the clip path's rects
                clip = _intersect(clip, pr)
            clip_pending = False
            path_rects = []
        elif op == "Do" and operands and isinstance(operands[-1], str):
            name = operands[-1]
            xref = xobjects.get(name)
            if xref:
                _handle_do(doc, xref, ctm, clip, results, depth)
        operands = []


def _handle_do(
    doc: pymupdf.Document,
    xref: int,
    ctm: Matrix,
    clip: pymupdf.Rect | None,
    results: list[dict[str, Any]],
    depth: int,
) -> None:
    try:
        subtype = doc.xref_get_key(xref, "Subtype")
    except Exception:
        return
    sub = subtype[1] if isinstance(subtype, tuple) and len(subtype) > 1 else ""

    if sub == "/Image":
        # The image fills the unit square under the current CTM.
        transform = _transform_rect(ctm, 0.0, 0.0, 1.0, 1.0)
        results.append({"xref": xref, "transform": transform, "clip": clip})
        return

    if sub == "/Form" and depth < _MAX_FORM_DEPTH:
        try:
            stream = doc.xref_stream(xref)
        except Exception:
            return
        if not stream:
            return
        form_matrix = _array_to_matrix(_safe_key(doc, xref, "Matrix")) or _IDENTITY
        form_ctm = _mat_mul(form_matrix, ctm)
        # Clip is also bounded by the form's BBox.
        form_clip = clip
        bbox_nums = _bbox_nums(doc, xref)
        if bbox_nums:
            bx0, by0, bx1, by1 = bbox_nums
            form_clip = _intersect(clip, _transform_rect(form_ctm, bx0, by0, bx1, by1))
        _walk(
            doc,
            stream,
            _safe_key(doc, xref, "Resources"),
            form_ctm,
            form_clip,
            results,
            depth + 1,
        )


def _safe_key(doc: pymupdf.Document, xref: int, key: str) -> Any:
    try:
        return doc.xref_get_key(xref, key)
    except Exception:
        return None


def _bbox_nums(doc: pymupdf.Document, xref: int) -> tuple[float, float, float, float] | None:
    val = _safe_key(doc, xref, "BBox")
    if not (isinstance(val, tuple) and len(val) > 1):
        return None
    nums = re.findall(r"[+-]?(?:\d+\.?\d*|\.\d+)", str(val[1]))
    if len(nums) >= 4:
        f = [float(x) for x in nums[:4]]
        return (min(f[0], f[2]), min(f[1], f[3]), max(f[0], f[2]), max(f[1], f[3]))
    return None
