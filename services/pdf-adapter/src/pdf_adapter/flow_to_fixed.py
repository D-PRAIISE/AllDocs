"""
Flow-mode -> fixed-mode conversion.

A DOCX-style flow document (paragraphs, headings, lists, images)
becomes a paginated fixed document so the existing PDF renderer can
output it. v1 layout engine:

  - one column per page (Letter, 1" margins)
  - greedy word wrap by approximate glyph width
  - heading sizes 24 / 18 / 14 / 12 by level (1-3, then body)
  - bullet / number prefix for list items
  - images placed at current cursor, scaled to fit text width

Tables, code blocks and complex inline marks are simplified to
paragraphs in v1 — richer rendering belongs in a real layout engine.
Used by the PDF exporter when given a flow UDM (cross-format DOCX -> PDF).
"""
from __future__ import annotations

import copy
from typing import Any

# Default page geometry (Letter, 1" margins).
_PAGE_W = 612.0
_PAGE_H = 792.0
_MARGIN = 72.0

# Greedy text-width estimation (sans-serif): char width ≈ size * 0.50.
_AVG_GLYPH_RATIO = 0.50
# Spacing rules.
_LINE_HEIGHT = 1.22
_PARA_SPACING_AFTER = 6.0
_HEADING_SPACING_BEFORE = 12.0
_HEADING_SPACING_AFTER = 6.0
_LIST_INDENT = 18.0
_DIVIDER_PAD = 8.0

_BODY_SIZE = 11.0
_HEADING_SIZES = {1: 24.0, 2: 18.0, 3: 14.0, 4: 12.5, 5: 12.0, 6: 11.5}

_FONT_ID_BODY = "font_xf_body"
_FONT_ID_BOLD = "font_xf_bold"


def flow_to_fixed(udm: dict[str, Any]) -> dict[str, Any]:
    """Return a new UDM with mode="fixed" derived from a flow UDM."""
    if udm.get("mode") != "flow":
        return udm

    out = copy.deepcopy(udm)
    out["mode"] = "fixed"
    # Ensure the two substituted fonts the render path needs.
    fonts = out.setdefault("resources", {}).setdefault("fonts", [])
    if not any(f.get("id") == _FONT_ID_BODY for f in fonts):
        fonts.append(
            {
                "id": _FONT_ID_BODY,
                "family": "sans-serif",
                "weight": 400,
                "style": "normal",
                "source": "substituted",
            }
        )
    if not any(f.get("id") == _FONT_ID_BOLD for f in fonts):
        fonts.append(
            {
                "id": _FONT_ID_BOLD,
                "family": "sans-serif",
                "weight": 700,
                "style": "normal",
                "source": "substituted",
            }
        )

    blocks = (udm.get("content") or {}).get("blocks") or []
    pages: list[dict[str, Any]] = []
    layout = _LayoutState()

    for block in blocks:
        _render_block(block, pages, layout, out["resources"])

    layout.finish(pages)
    out["content"] = {"pages": pages}
    return out


class _LayoutState:
    def __init__(self) -> None:
        self.page_w = _PAGE_W
        self.page_h = _PAGE_H
        self.margin = _MARGIN
        self.text_x = self.margin
        self.text_w = self.page_w - 2 * self.margin
        self.cursor_y = self.margin
        self.runs: list[dict[str, Any]] = []
        self.images: list[dict[str, Any]] = []

    def remaining(self) -> float:
        return (self.page_h - self.margin) - self.cursor_y

    def page_break(self, pages: list[dict[str, Any]]) -> None:
        layers: list[dict[str, Any]] = []
        if self.runs:
            layers.append({"type": "text", "runs": self.runs})
        layers.extend({"type": "image", **img} for img in self.images)
        pages.append(
            {
                "number": len(pages) + 1,
                "width": {"value": self.page_w, "unit": "pt"},
                "height": {"value": self.page_h, "unit": "pt"},
                "layers": layers,
                "rotation": 0,
                "_meta": {},
            }
        )
        self.runs = []
        self.images = []
        self.cursor_y = self.margin

    def ensure_room(self, needed: float, pages: list[dict[str, Any]]) -> None:
        if self.remaining() < needed:
            self.page_break(pages)

    def add_text_line(
        self,
        text: str,
        size: float,
        bold: bool,
        x: float,
        color: dict[str, Any] | None,
    ) -> None:
        # Run y is the baseline (bbox bottom in our convention).
        baseline = self.cursor_y + size
        self.runs.append(
            {
                "text": text,
                "font_id": _FONT_ID_BOLD if bold else _FONT_ID_BODY,
                "font_size": {"value": size, "unit": "pt"},
                "color": color
                or {"literal": {"kind": "rgb", "r": 0, "g": 0, "b": 0}},
                "x": {"value": x, "unit": "pt"},
                "y": {"value": baseline, "unit": "pt"},
            }
        )
        self.cursor_y += size * _LINE_HEIGHT

    def finish(self, pages: list[dict[str, Any]]) -> None:
        if self.runs or self.images:
            self.page_break(pages)
        if not pages:
            self.page_break(pages)


def _wrap_text(text: str, size: float, max_w: float) -> list[str]:
    """Greedy word wrap; estimates glyph width by char × size × ratio."""
    if not text:
        return [""]
    char_w = size * _AVG_GLYPH_RATIO
    max_chars = max(1, int(max_w / char_w))
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        if len(cur) + 1 + len(w) <= max_chars:
            cur = f"{cur} {w}"
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def _inline_text(inlines: list[dict[str, Any]] | None) -> str:
    if not inlines:
        return ""
    parts: list[str] = []
    for inline in inlines:
        t = inline.get("type")
        if t == "text":
            parts.append(inline.get("text", ""))
        elif t == "br":
            parts.append("\n")
        elif t == "link":
            parts.append(_inline_text(inline.get("inlines")))
    return "".join(parts)


def _render_block(
    block: dict[str, Any],
    pages: list[dict[str, Any]],
    layout: _LayoutState,
    resources: dict[str, Any],
) -> None:
    btype = block.get("type")

    if btype == "heading":
        level = int(block.get("level", 1) or 1)
        size = _HEADING_SIZES.get(level, _BODY_SIZE)
        layout.cursor_y += _HEADING_SPACING_BEFORE
        text = _inline_text(block.get("inlines"))
        for line in _wrap_text(text, size, layout.text_w):
            layout.ensure_room(size * _LINE_HEIGHT, pages)
            layout.add_text_line(line, size, bold=True, x=layout.text_x, color=None)
        layout.cursor_y += _HEADING_SPACING_AFTER
        return

    if btype == "paragraph":
        text = _inline_text(block.get("inlines"))
        for line in _wrap_text(text, _BODY_SIZE, layout.text_w):
            layout.ensure_room(_BODY_SIZE * _LINE_HEIGHT, pages)
            layout.add_text_line(line, _BODY_SIZE, bold=False, x=layout.text_x, color=None)
        layout.cursor_y += _PARA_SPACING_AFTER
        return

    if btype == "list":
        ordered = bool(block.get("ordered"))
        start = int(block.get("start", 1) or 1)
        for idx, item in enumerate(block.get("items") or []):
            prefix = f"{start + idx}. " if ordered else "• "
            indent = _LIST_INDENT
            for sub in item.get("blocks") or []:
                if sub.get("type") == "paragraph":
                    text = prefix + _inline_text(sub.get("inlines"))
                    for li, line in enumerate(
                        _wrap_text(text, _BODY_SIZE, layout.text_w - indent)
                    ):
                        layout.ensure_room(_BODY_SIZE * _LINE_HEIGHT, pages)
                        x = layout.text_x + (indent if li > 0 else 0)
                        layout.add_text_line(line, _BODY_SIZE, bold=False, x=x, color=None)
                    prefix = ""
                else:
                    _render_block(sub, pages, layout, resources)
        layout.cursor_y += _PARA_SPACING_AFTER
        return

    if btype == "divider":
        layout.ensure_room(_DIVIDER_PAD * 2, pages)
        layout.cursor_y += _DIVIDER_PAD
        # A divider is rendered as a hairline rect — push it via the
        # images list slot is wrong; we encode it as a shape via the
        # text-line cursor: skip drawing for v1 and just keep spacing.
        layout.cursor_y += _DIVIDER_PAD
        return

    if btype == "image":
        image_id = block.get("image_id")
        if not image_id:
            return
        # Default to text width; shrink to actual image aspect later.
        w = layout.text_w
        h = w * 0.75
        if block.get("width") and block.get("height"):
            try:
                w_pt = float(block["width"]["value"])
                h_pt = float(block["height"]["value"])
                if w_pt > 0 and h_pt > 0:
                    if w_pt > layout.text_w:
                        scale = layout.text_w / w_pt
                        w, h = w_pt * scale, h_pt * scale
                    else:
                        w, h = w_pt, h_pt
            except Exception:
                pass
        layout.ensure_room(h + _PARA_SPACING_AFTER, pages)
        layout.images.append(
            {
                "image_id": image_id,
                "x": {"value": layout.text_x, "unit": "pt"},
                "y": {"value": layout.cursor_y, "unit": "pt"},
                "width": {"value": w, "unit": "pt"},
                "height": {"value": h, "unit": "pt"},
            }
        )
        layout.cursor_y += h + _PARA_SPACING_AFTER
        return

    if btype == "quote":
        text = _inline_text(block.get("citation"))
        # Render nested blocks first.
        for sub in block.get("blocks") or []:
            _render_block(sub, pages, layout, resources)
        if text:
            for line in _wrap_text("— " + text, _BODY_SIZE, layout.text_w):
                layout.ensure_room(_BODY_SIZE * _LINE_HEIGHT, pages)
                layout.add_text_line(line, _BODY_SIZE, bold=False, x=layout.text_x, color=None)
        layout.cursor_y += _PARA_SPACING_AFTER
        return

    if btype == "code":
        text = str(block.get("content") or "")
        for line in text.splitlines() or [""]:
            layout.ensure_room(_BODY_SIZE * _LINE_HEIGHT, pages)
            layout.add_text_line(line, _BODY_SIZE - 1, bold=False, x=layout.text_x, color=None)
        layout.cursor_y += _PARA_SPACING_AFTER
        return

    # table / unknown: render any inline text the block may have
    text = _inline_text(block.get("inlines"))
    if text:
        for line in _wrap_text(text, _BODY_SIZE, layout.text_w):
            layout.ensure_room(_BODY_SIZE * _LINE_HEIGHT, pages)
            layout.add_text_line(line, _BODY_SIZE, bold=False, x=layout.text_x, color=None)
        layout.cursor_y += _PARA_SPACING_AFTER
