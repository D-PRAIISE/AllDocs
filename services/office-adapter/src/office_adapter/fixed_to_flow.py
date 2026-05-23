"""
Fixed-mode -> flow-mode conversion.

A positioned-text PDF (mode="fixed") becomes a flow document
(mode="flow") by reading the text runs in spatial order and grouping
them into lines and paragraphs. Output blocks: headings (inferred from
larger font sizes), paragraphs, and image blocks. Tables, lists,
shapes, annotations and form fields are dropped in v1 — they need
richer inference.

Used by the DOCX exporter when given a fixed UDM (cross-format PDF -> DOCX).
"""
from __future__ import annotations

import copy
from typing import Any

# A run whose font size is this many times the body median is treated
# as a heading. Multiple levels are derived from a 0.15 step.
_HEADING_THRESHOLD = 1.2
_HEADING_STEP = 0.15

# Lines with vertical gap > this * line height start a new paragraph.
_PARAGRAPH_GAP = 1.5

# Two runs are on the same line if their baselines differ by less than this.
_LINE_TOL = 2.0


def fixed_to_flow(udm: dict[str, Any]) -> dict[str, Any]:
    """Return a new UDM with mode="flow" derived from a fixed UDM."""
    if udm.get("mode") != "fixed":
        return udm

    pages = (udm.get("content") or {}).get("pages") or []

    all_runs: list[dict[str, Any]] = []
    image_blocks: list[tuple[float, dict[str, Any]]] = []  # (sort_y, block)
    cumulative_y = 0.0

    for page in pages:
        page_h = float((page.get("height") or {}).get("value", 842))
        for layer in page.get("layers", []):
            t = layer.get("type")
            if t == "text":
                for run in layer.get("runs", []):
                    text = run.get("text", "")
                    if not text or not text.strip():
                        continue
                    y = float(run["y"]["value"]) + cumulative_y
                    x = float(run["x"]["value"])
                    all_runs.append(
                        {
                            "text": text,
                            "x": x,
                            "y": y,
                            "size": float(run["font_size"]["value"]),
                            "color": run.get("color"),
                            "font_id": run.get("font_id"),
                        }
                    )
            elif t == "image":
                y = float(layer["y"]["value"]) + cumulative_y
                image_blocks.append(
                    (
                        y,
                        {
                            "type": "image",
                            "image_id": layer["image_id"],
                            "width": copy.deepcopy(layer.get("width")),
                            "height": copy.deepcopy(layer.get("height")),
                        },
                    )
                )
        cumulative_y += page_h

    # Compute the body-text size baseline for heading detection.
    sizes = [r["size"] for r in all_runs]
    body = _median(sizes) if sizes else 12.0

    # Sort runs by (y, then x), group into lines, then lines into paragraphs.
    all_runs.sort(key=lambda r: (r["y"], r["x"]))
    lines: list[list[dict[str, Any]]] = []
    for run in all_runs:
        if lines and abs(lines[-1][-1]["y"] - run["y"]) <= _LINE_TOL:
            lines[-1].append(run)
        else:
            lines.append([run])
    # Sort each line left-to-right.
    for ln in lines:
        ln.sort(key=lambda r: r["x"])

    paragraphs: list[list[list[dict[str, Any]]]] = []
    for ln in lines:
        if not paragraphs:
            paragraphs.append([ln])
            continue
        prev = paragraphs[-1][-1]
        gap = ln[0]["y"] - prev[0]["y"]
        line_h = max((r["size"] for r in prev), default=12.0) * 1.2
        if gap > line_h * _PARAGRAPH_GAP or _has_size_jump(prev, ln):
            paragraphs.append([ln])
        else:
            paragraphs[-1].append(ln)

    blocks: list[dict[str, Any]] = []
    # Interleave images by their y position.
    img_iter = iter(sorted(image_blocks, key=lambda iy: iy[0]))
    next_img = next(img_iter, None)

    for para in paragraphs:
        para_y = para[0][0]["y"]
        while next_img is not None and next_img[0] < para_y:
            blocks.append(next_img[1])
            next_img = next(img_iter, None)

        text = " ".join(_line_text(ln) for ln in para).strip()
        if not text:
            continue
        para_size = _median([r["size"] for ln in para for r in ln])
        if para_size >= body * _HEADING_THRESHOLD:
            level = min(6, max(1, int((para_size / body - 1.0) / _HEADING_STEP)))
            blocks.append(
                {
                    "type": "heading",
                    "level": level,
                    "inlines": [{"type": "text", "text": text}],
                }
            )
        else:
            blocks.append(
                {
                    "type": "paragraph",
                    "inlines": [{"type": "text", "text": text}],
                }
            )

    while next_img is not None:
        blocks.append(next_img[1])
        next_img = next(img_iter, None)

    out = copy.deepcopy(udm)
    out["mode"] = "flow"
    out["content"] = {"blocks": blocks}
    return out


def _line_text(line: list[dict[str, Any]]) -> str:
    """Join runs on the same line with spaces where there's a horizontal gap."""
    parts: list[str] = []
    last_end: float | None = None
    for run in line:
        t = run["text"]
        if not t:
            continue
        if parts and last_end is not None:
            gap = run["x"] - last_end
            if gap > run["size"] * 0.2 and not parts[-1].endswith(" ") and not t.startswith(" "):
                parts.append(" ")
        parts.append(t)
        last_end = run["x"] + len(t) * run["size"] * 0.55
    return "".join(parts)


def _has_size_jump(prev_line: list[dict[str, Any]], next_line: list[dict[str, Any]]) -> bool:
    """Switching size class (heading <-> body) breaks the paragraph."""
    ps = _median([r["size"] for r in prev_line])
    ns = _median([r["size"] for r in next_line])
    if ps <= 0 or ns <= 0:
        return False
    return abs(ps - ns) / max(ps, ns) > 0.25


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
