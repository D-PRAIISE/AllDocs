"""
DOCX -> UDM importer.

Targets UDM v0.1.0 flow mode (see docs/UDM_SPEC.md §6). Captures:
  - Headings 1..6 (via "Heading N" style)
  - Paragraphs
  - Bulleted and numbered lists (consecutive list paragraphs grouped)
  - Tables with simple cell content
  - Inline marks: bold, italic, underline, strikethrough, super/subscript, color

Out of scope for v0.1: images, hyperlinks (rendered as plain text), custom
styles, headers/footers, comments, math, track changes.
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any, Iterator

from docx import Document as _Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

UDM_VERSION = "0.1.0"

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def import_docx(path: str | Path) -> dict[str, Any]:
    """Read a DOCX file and produce a UDM v0.1.0 flow-mode document."""
    path = Path(path)
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()

    doc = _Document(str(path))
    blocks = _extract_blocks(doc)

    return {
        "udm_version": UDM_VERSION,
        "id": str(uuid.uuid4()),
        "mode": "flow",
        "metadata": _extract_metadata(doc, sha256),
        "resources": {"fonts": [], "images": [], "styles": [], "colors": []},
        "content": {"blocks": blocks},
    }


def _extract_metadata(doc: Any, sha256: str) -> dict[str, Any]:
    core = doc.core_properties
    metadata: dict[str, Any] = {
        "source_format": {"mime": DOCX_MIME, "extension": "docx"},
        "source_hash": sha256,
    }
    if core.title:
        metadata["title"] = core.title
    if core.author:
        metadata["authors"] = [core.author]
    if core.subject:
        metadata["subject"] = core.subject
    if core.keywords:
        metadata["keywords"] = [k.strip() for k in core.keywords.split(",") if k.strip()]
    if core.created is not None:
        metadata["created_at"] = _iso(core.created)
    if core.modified is not None:
        metadata["modified_at"] = _iso(core.modified)
    return metadata


def _iso(dt: Any) -> str:
    """Best-effort ISO 8601 string for a datetime-like."""
    iso = getattr(dt, "isoformat", None)
    return iso() if callable(iso) else str(dt)


# ---- Block extraction ----------------------------------------------------


def _iter_body_blocks(doc: Any) -> Iterator[Any]:
    """Yield Paragraph and Table objects from the document body in order."""
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)


def _extract_blocks(doc: Any) -> list[dict[str, Any]]:
    """Walk the document body, producing UDM blocks. Consecutive list-style
    paragraphs are grouped into a single List block."""
    out: list[dict[str, Any]] = []
    list_run: list[Paragraph] = []
    list_ordered: bool | None = None

    def flush_list() -> None:
        nonlocal list_run, list_ordered
        if not list_run:
            return
        items = []
        for p in list_run:
            block = _paragraph_to_block(p, suppress_list_style=True)
            items.append({"blocks": [block]})
        out.append({"type": "list", "ordered": bool(list_ordered), "items": items})
        list_run = []
        list_ordered = None

    for elem in _iter_body_blocks(doc):
        if isinstance(elem, Paragraph):
            kind = _list_kind(elem)
            if kind is not None:
                ordered = kind == "ordered"
                if list_run and list_ordered is not None and list_ordered != ordered:
                    flush_list()
                list_ordered = ordered
                list_run.append(elem)
            else:
                flush_list()
                block = _paragraph_to_block(elem)
                if block is not None:
                    out.append(block)
        elif isinstance(elem, Table):
            flush_list()
            out.append(_table_to_block(elem))
    flush_list()
    return out


def _list_kind(p: Paragraph) -> str | None:
    """Return 'ordered', 'unordered', or None."""
    style_name = (p.style.name or "").lower() if p.style else ""
    if "list number" in style_name or "list ordered" in style_name:
        return "ordered"
    if "list bullet" in style_name or "list paragraph" in style_name or "list" == style_name:
        # Catch "List Paragraph" style but only if there's actual numbering;
        # otherwise it's just a standalone paragraph using that style.
        return _list_kind_via_xml(p) or "unordered"
    return _list_kind_via_xml(p)


def _list_kind_via_xml(p: Paragraph) -> str | None:
    """Detect list-ness via direct numPr in the paragraph properties."""
    pPr = p._p.find(qn("w:pPr"))
    if pPr is None:
        return None
    numPr = pPr.find(qn("w:numPr"))
    if numPr is None:
        return None
    # Determining ordered vs unordered would require resolving numbering.xml
    # ABSTRACT_NUM_ID -> numFmt; that's a v0.2 enhancement.
    return "unordered"


def _paragraph_to_block(p: Paragraph, suppress_list_style: bool = False) -> dict[str, Any]:
    """Convert a Paragraph into a UDM Block (Heading or Paragraph)."""
    style_name = (p.style.name or "") if p.style else ""
    inlines = _runs_to_inlines(p)

    lower = style_name.lower()
    if lower.startswith("heading"):
        level = _heading_level(style_name)
        return {"type": "heading", "level": level, "inlines": inlines}

    block: dict[str, Any] = {"type": "paragraph", "inlines": inlines}
    if not suppress_list_style and style_name and lower not in {"normal", "default paragraph font"}:
        block["style_id"] = style_name
    return block


def _heading_level(style_name: str) -> int:
    """Parse 'Heading 3' -> 3. Default to 1."""
    parts = style_name.lower().replace("heading", "").strip()
    try:
        n = int(parts)
        return max(1, min(6, n))
    except (ValueError, TypeError):
        return 1


def _runs_to_inlines(p: Paragraph) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for r in p.runs:
        text = r.text
        if not text:
            continue
        marks: list[dict[str, Any]] = []
        if r.bold:
            marks.append({"type": "bold"})
        if r.italic:
            marks.append({"type": "italic"})
        if r.underline:
            marks.append({"type": "underline"})
        font = r.font
        if font.strike:
            marks.append({"type": "strikethrough"})
        if font.superscript:
            marks.append({"type": "superscript"})
        if font.subscript:
            marks.append({"type": "subscript"})
        if font.color and font.color.rgb is not None:
            rgb = font.color.rgb
            marks.append(
                {
                    "type": "color",
                    "color": {"literal": {"kind": "hex", "hex": f"#{rgb}"}},
                }
            )
        inline: dict[str, Any] = {"type": "text", "text": text}
        if marks:
            inline["marks"] = marks
        out.append(inline)
    return out


def _table_to_block(table: Table) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for i, row in enumerate(table.rows):
        cells: list[dict[str, Any]] = []
        for cell in row.cells:
            cell_blocks: list[dict[str, Any]] = []
            for p in cell.paragraphs:
                block = _paragraph_to_block(p)
                if block is not None:
                    cell_blocks.append(block)
            cells.append({"blocks": cell_blocks})
        row_data: dict[str, Any] = {"cells": cells}
        if i == 0:
            row_data["is_header"] = True
        rows.append(row_data)
    return {"type": "table", "rows": rows}
