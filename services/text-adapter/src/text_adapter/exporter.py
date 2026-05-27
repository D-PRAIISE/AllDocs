"""
UDM flow → Markdown / HTML exporters.

Symmetric with the importer's block coverage. The output is intended
to be a clean, idiomatic CommonMark or HTML5 document, not the
shortest possible representation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

UDM_VERSION = "0.1.0"


def export_markdown(udm: dict[str, Any], output_path: str | Path) -> None:
    if udm.get("mode") != "flow":
        raise ValueError(f"Markdown export requires flow UDM; got mode={udm.get('mode')!r}")
    blocks = (udm.get("content") or {}).get("blocks") or []
    md = _blocks_to_md(blocks)
    Path(output_path).write_text(md, encoding="utf-8")


def export_html(udm: dict[str, Any], output_path: str | Path) -> None:
    if udm.get("mode") != "flow":
        raise ValueError(f"HTML export requires flow UDM; got mode={udm.get('mode')!r}")
    blocks = (udm.get("content") or {}).get("blocks") or []
    title = (udm.get("metadata") or {}).get("title") or "Document"
    body = _blocks_to_html(blocks, indent=4)
    out = (
        "<!doctype html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        "<meta charset=\"utf-8\">\n"
        f"<title>{_html_escape(title)}</title>\n"
        "</head>\n"
        "<body>\n"
        f"{body}\n"
        "</body>\n"
        "</html>\n"
    )
    Path(output_path).write_text(out, encoding="utf-8")


# ---- Markdown ------------------------------------------------------------


def _blocks_to_md(blocks: list[dict[str, Any]], indent: str = "") -> str:
    parts: list[str] = []
    for i, b in enumerate(blocks):
        rendered = _block_to_md(b, indent)
        if rendered:
            parts.append(rendered)
    return "\n\n".join(parts).rstrip() + "\n"


def _block_to_md(b: dict[str, Any], indent: str = "") -> str:
    t = b.get("type")
    if t == "heading":
        level = max(1, min(6, int(b.get("level") or 1)))
        return indent + "#" * level + " " + _inlines_to_md(b.get("inlines") or [])
    if t == "paragraph":
        return indent + _inlines_to_md(b.get("inlines") or [])
    if t == "divider":
        return indent + "---"
    if t == "code":
        lang = b.get("language") or ""
        text = (b.get("text") or "").rstrip("\n")
        fence = "```"
        return f"{indent}{fence}{lang}\n{text}\n{indent}{fence}"
    if t == "quote":
        inner = _blocks_to_md(b.get("blocks") or [], indent="")
        return "\n".join(indent + "> " + line for line in inner.rstrip("\n").splitlines())
    if t == "list":
        return _md_list(b, indent)
    if t == "table":
        return _md_table(b)
    return ""


def _md_list(b: dict[str, Any], indent: str) -> str:
    ordered = bool(b.get("ordered"))
    items = b.get("items") or []
    lines: list[str] = []
    for n, item in enumerate(items, start=1):
        prefix = f"{n}. " if ordered else "- "
        inner_blocks = item.get("blocks") or []
        if not inner_blocks:
            lines.append(indent + prefix)
            continue
        first = inner_blocks[0]
        first_text = _block_to_md(first, indent="").lstrip()
        # First line gets the marker; subsequent block lines indent
        # under the marker so the list reads as one item.
        lines.append(indent + prefix + first_text)
        cont_indent = indent + (" " * len(prefix))
        for rest in inner_blocks[1:]:
            rendered = _block_to_md(rest, indent=cont_indent)
            if rendered:
                lines.append("")
                lines.append(rendered)
    return "\n".join(lines)


def _md_table(b: dict[str, Any]) -> str:
    headers = b.get("header_rows") or []
    rows = b.get("rows") or []
    # GFM tables need exactly one header row. Fold any multiple header
    # rows into a single delimiter row, picking the first header row's
    # cells as the header text.
    header_cells: list[str] = []
    if headers:
        first_header = headers[0]
        for cell in first_header.get("cells") or []:
            header_cells.append(_table_cell_md(cell))
    elif rows:
        # No header → fabricate empty header from the row's column count.
        first_row = rows[0]
        header_cells = ["" for _ in first_row.get("cells") or []]
    if not header_cells:
        return ""
    sep = ["---" for _ in header_cells]
    out = ["| " + " | ".join(header_cells) + " |", "| " + " | ".join(sep) + " |"]
    for r in rows:
        cells = [_table_cell_md(c) for c in r.get("cells") or []]
        # Pad / trim to header column count.
        while len(cells) < len(header_cells):
            cells.append("")
        cells = cells[: len(header_cells)]
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


def _table_cell_md(cell: dict[str, Any]) -> str:
    blocks = cell.get("blocks") or []
    parts: list[str] = []
    for b in blocks:
        if b.get("type") == "paragraph":
            parts.append(_inlines_to_md(b.get("inlines") or []))
        else:
            # Non-paragraph in a table cell — flatten to plain text.
            inner = _block_to_md(b)
            parts.append(inner.replace("\n", " "))
    return " ".join(parts).replace("|", "\\|")


def _inlines_to_md(inlines: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for inline in inlines:
        t = inline.get("type")
        if t == "text":
            out.append(_apply_marks_md(str(inline.get("text", "")), inline.get("marks") or []))
        elif t == "br":
            out.append("  \n")
        elif t == "inline_image":
            alt = (inline.get("alt") or "").replace("]", "\\]")
            src = inline.get("src") or ""
            out.append(f"![{alt}]({src})")
    return "".join(out)


def _apply_marks_md(text: str, marks: list[dict[str, Any]]) -> str:
    # Marks are nested — apply from inner-most to outer-most.
    for m in marks:
        kind = m.get("type")
        if kind == "bold":
            text = f"**{text}**"
        elif kind == "italic":
            text = f"*{text}*"
        elif kind == "code":
            text = f"`{text}`"
        elif kind == "strike":
            text = f"~~{text}~~"
        elif kind == "link":
            href = str(m.get("href") or "")
            text = f"[{text}]({href})"
    return text


# ---- HTML ----------------------------------------------------------------


def _blocks_to_html(blocks: list[dict[str, Any]], indent: int = 0) -> str:
    parts: list[str] = []
    for b in blocks:
        rendered = _block_to_html(b, indent)
        if rendered:
            parts.append(rendered)
    return "\n".join(parts)


def _block_to_html(b: dict[str, Any], indent: int) -> str:
    pad = " " * indent
    t = b.get("type")
    if t == "heading":
        level = max(1, min(6, int(b.get("level") or 1)))
        return f"{pad}<h{level}>{_inlines_to_html(b.get('inlines') or [])}</h{level}>"
    if t == "paragraph":
        return f"{pad}<p>{_inlines_to_html(b.get('inlines') or [])}</p>"
    if t == "divider":
        return f"{pad}<hr>"
    if t == "code":
        lang = b.get("language")
        cls = f' class="language-{_html_escape(lang)}"' if lang else ""
        text = _html_escape(b.get("text") or "")
        return f"{pad}<pre><code{cls}>{text}</code></pre>"
    if t == "quote":
        inner = _blocks_to_html(b.get("blocks") or [], indent + 2)
        return f"{pad}<blockquote>\n{inner}\n{pad}</blockquote>"
    if t == "list":
        return _html_list(b, indent)
    if t == "table":
        return _html_table(b, indent)
    return ""


def _html_list(b: dict[str, Any], indent: int) -> str:
    pad = " " * indent
    tag = "ol" if b.get("ordered") else "ul"
    items = b.get("items") or []
    parts = [f"{pad}<{tag}>"]
    for item in items:
        inner = _blocks_to_html(item.get("blocks") or [], indent + 4).strip()
        # When the only inner block is a paragraph, hoist its inlines
        # into the <li> directly to avoid <li><p>...</p></li> noise.
        inner_blocks = item.get("blocks") or []
        if len(inner_blocks) == 1 and inner_blocks[0].get("type") == "paragraph":
            inline_text = _inlines_to_html(inner_blocks[0].get("inlines") or [])
            parts.append(f"{pad}  <li>{inline_text}</li>")
        else:
            parts.append(f"{pad}  <li>\n{inner}\n{pad}  </li>")
    parts.append(f"{pad}</{tag}>")
    return "\n".join(parts)


def _html_table(b: dict[str, Any], indent: int) -> str:
    pad = " " * indent
    headers = b.get("header_rows") or []
    rows = b.get("rows") or []
    parts = [f"{pad}<table>"]
    if headers:
        parts.append(f"{pad}  <thead>")
        for r in headers:
            parts.append(_html_table_row(r, indent + 4, header=True))
        parts.append(f"{pad}  </thead>")
    if rows:
        parts.append(f"{pad}  <tbody>")
        for r in rows:
            parts.append(_html_table_row(r, indent + 4, header=False))
        parts.append(f"{pad}  </tbody>")
    parts.append(f"{pad}</table>")
    return "\n".join(parts)


def _html_table_row(r: dict[str, Any], indent: int, *, header: bool) -> str:
    pad = " " * indent
    tag = "th" if header else "td"
    cells = r.get("cells") or []
    pieces: list[str] = [f"{pad}<tr>"]
    for cell in cells:
        blocks = cell.get("blocks") or []
        if len(blocks) == 1 and blocks[0].get("type") == "paragraph":
            inline = _inlines_to_html(blocks[0].get("inlines") or [])
            pieces.append(f"{pad}  <{tag}>{inline}</{tag}>")
        else:
            inner = _blocks_to_html(blocks, indent + 4).strip()
            pieces.append(f"{pad}  <{tag}>\n{inner}\n{pad}  </{tag}>")
    pieces.append(f"{pad}</tr>")
    return "\n".join(pieces)


def _inlines_to_html(inlines: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for inline in inlines:
        t = inline.get("type")
        if t == "text":
            out.append(_apply_marks_html(_html_escape(str(inline.get("text", ""))), inline.get("marks") or []))
        elif t == "br":
            out.append("<br>")
        elif t == "inline_image":
            src = _html_escape(inline.get("src") or "")
            alt = _html_escape(inline.get("alt") or "")
            out.append(f'<img src="{src}" alt="{alt}">')
    return "".join(out)


def _apply_marks_html(text: str, marks: list[dict[str, Any]]) -> str:
    for m in marks:
        kind = m.get("type")
        if kind == "bold":
            text = f"<strong>{text}</strong>"
        elif kind == "italic":
            text = f"<em>{text}</em>"
        elif kind == "underline":
            text = f"<u>{text}</u>"
        elif kind == "strike":
            text = f"<s>{text}</s>"
        elif kind == "code":
            text = f"<code>{text}</code>"
        elif kind == "sub":
            text = f"<sub>{text}</sub>"
        elif kind == "sup":
            text = f"<sup>{text}</sup>"
        elif kind == "link":
            href = _html_escape(str(m.get("href") or ""))
            text = f'<a href="{href}">{text}</a>'
    return text


def _html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
