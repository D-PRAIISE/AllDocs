"""
Markdown / HTML → UDM flow-mode importer.

Both formats land in the same UDM flow block representation used by
the office adapter, so the existing FlowEditor + FlowContentView
render them with no changes.

Block coverage (v0.1):
- Heading 1..6 (# / ##)
- Paragraph
- Bulleted + numbered List + nested
- Table (GFM in MD; <table> in HTML)
- Blockquote
- Code block (fenced ```)
- Horizontal rule (---)
- Inline marks: bold, italic, code, strikethrough, link
- Inline image (img)

Out of scope for v0.1: footnotes, task lists, math, definition lists,
custom containers, headers/footers, MD frontmatter beyond plain title.
"""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

import bleach
from bs4 import BeautifulSoup, NavigableString, Tag
from markdown_it import MarkdownIt

UDM_VERSION = "0.1.0"

# Markdown-it config: GFM-ish (tables, strikethrough), commonmark for
# everything else. No raw HTML — sanitised separately if we ever
# need it.
_MD = (
    MarkdownIt("commonmark", {"html": False, "linkify": True, "typographer": False})
    .enable(["table", "strikethrough"])
)

# bleach whitelist for HTML import. Anything outside is stripped.
_ALLOWED_TAGS = [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote",
    "pre", "code",
    "table", "thead", "tbody", "tr", "th", "td",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup",
    "a", "img",
    "div", "span",  # tolerated, contents are walked
]
_ALLOWED_ATTRS = {
    "a": ["href", "title"],
    "img": ["src", "alt", "title", "width", "height"],
}


def import_markdown(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    raw = path.read_text(encoding="utf-8")
    sha256 = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    tokens = _MD.parse(raw)
    blocks = _md_tokens_to_blocks(tokens)
    return _wrap_doc(blocks, sha256, mime="text/markdown", ext="md", title=_first_h1(blocks))


def import_html(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    raw = path.read_text(encoding="utf-8")
    sha256 = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    # Pull title out of <head> first — bleach's `strip=True` would
    # remove the <title> tag but keep its inner text, which would
    # otherwise show up as a floating paragraph in the body.
    raw_soup = BeautifulSoup(raw, "html.parser")
    title: str | None = None
    if raw_soup.title and raw_soup.title.string:
        title = raw_soup.title.string.strip()
    body_node = raw_soup.body
    body_html = body_node.decode_contents() if body_node else raw
    # Now sanitise just the body content.
    clean = bleach.clean(
        body_html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=["http", "https", "mailto", "data"],
        strip=True,
        strip_comments=True,
    )
    soup = BeautifulSoup(clean, "html.parser")
    blocks = _html_root_to_blocks(soup)
    if not title:
        title = _first_h1(blocks)
    return _wrap_doc(blocks, sha256, mime="text/html", ext="html", title=title)


def _wrap_doc(
    blocks: list[dict[str, Any]],
    sha256: str,
    *,
    mime: str,
    ext: str,
    title: str | None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "source_format": {"mime": mime, "extension": ext},
        "source_hash": sha256,
    }
    if title:
        metadata["title"] = title
    return {
        "udm_version": UDM_VERSION,
        "id": str(uuid.uuid4()),
        "mode": "flow",
        "metadata": metadata,
        "resources": {"fonts": [], "images": [], "styles": [], "colors": []},
        "content": {"blocks": blocks},
    }


def _first_h1(blocks: list[dict[str, Any]]) -> str | None:
    for b in blocks:
        if b.get("type") == "heading" and b.get("level") == 1:
            return _block_plain_text(b)
    return None


def _block_plain_text(b: dict[str, Any]) -> str:
    """Inline-flatten a block to its plain-text content."""
    out: list[str] = []
    for inline in b.get("inlines", []) or []:
        if inline.get("type") == "text":
            out.append(str(inline.get("text", "")))
    return "".join(out).strip() or None  # type: ignore[return-value]


# ---- Markdown-it AST -> UDM blocks --------------------------------------


def _md_tokens_to_blocks(tokens: list[Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        t = tok.type
        if t == "heading_open":
            level = int(tok.tag[1])
            inline = tokens[i + 1]
            blocks.append({
                "type": "heading",
                "level": level,
                "inlines": _md_inline_to_inlines(inline.children or []),
            })
            i += 3  # heading_open, inline, heading_close
            continue
        if t == "paragraph_open":
            inline = tokens[i + 1]
            blocks.append({
                "type": "paragraph",
                "inlines": _md_inline_to_inlines(inline.children or []),
            })
            i += 3
            continue
        if t in ("bullet_list_open", "ordered_list_open"):
            ordered = t == "ordered_list_open"
            j, items = _consume_md_list(tokens, i + 1, ordered)
            blocks.append({
                "type": "list",
                "ordered": ordered,
                "items": items,
            })
            i = j + 1
            continue
        if t == "blockquote_open":
            j = i + 1
            depth = 1
            inner_tokens: list[Any] = []
            while j < len(tokens) and depth > 0:
                if tokens[j].type == "blockquote_open":
                    depth += 1
                elif tokens[j].type == "blockquote_close":
                    depth -= 1
                    if depth == 0:
                        break
                inner_tokens.append(tokens[j])
                j += 1
            blocks.append({
                "type": "quote",
                "blocks": _md_tokens_to_blocks(inner_tokens),
            })
            i = j + 1
            continue
        if t in ("fence", "code_block"):
            blocks.append({
                "type": "code",
                "language": (tok.info or "").strip() or None,
                "text": tok.content,
            })
            i += 1
            continue
        if t == "hr":
            blocks.append({"type": "divider"})
            i += 1
            continue
        if t == "table_open":
            j, table = _consume_md_table(tokens, i + 1)
            blocks.append(table)
            i = j + 1
            continue
        # Unknown — skip to make import resilient.
        i += 1
    return blocks


def _consume_md_list(
    tokens: list[Any], start: int, ordered: bool
) -> tuple[int, list[dict[str, Any]]]:
    items: list[dict[str, Any]] = []
    i = start
    depth = 1
    while i < len(tokens) and depth > 0:
        t = tokens[i].type
        if t in ("bullet_list_open", "ordered_list_open"):
            depth += 1
            i += 1
            continue
        if t in ("bullet_list_close", "ordered_list_close"):
            depth -= 1
            if depth == 0:
                break
            i += 1
            continue
        if t == "list_item_open":
            # Walk inner tokens up to matching list_item_close.
            j = i + 1
            inner: list[Any] = []
            inner_depth = 1
            while j < len(tokens) and inner_depth > 0:
                ti = tokens[j].type
                if ti == "list_item_open":
                    inner_depth += 1
                elif ti == "list_item_close":
                    inner_depth -= 1
                    if inner_depth == 0:
                        break
                inner.append(tokens[j])
                j += 1
            items.append({"blocks": _md_tokens_to_blocks(inner)})
            i = j + 1
            continue
        i += 1
    _ = ordered
    return i, items


def _consume_md_table(tokens: list[Any], start: int) -> tuple[int, dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    headers: list[dict[str, Any]] = []
    i = start
    in_thead = False
    in_tbody = False
    while i < len(tokens):
        t = tokens[i].type
        if t == "table_close":
            break
        if t == "thead_open":
            in_thead = True
            in_tbody = False
        elif t == "thead_close":
            in_thead = False
        elif t == "tbody_open":
            in_tbody = True
            in_thead = False
        elif t == "tbody_close":
            in_tbody = False
        elif t == "tr_open":
            cells: list[dict[str, Any]] = []
            j = i + 1
            while j < len(tokens) and tokens[j].type != "tr_close":
                if tokens[j].type in ("th_open", "td_open"):
                    inline = tokens[j + 1]
                    cells.append({
                        "blocks": [{
                            "type": "paragraph",
                            "inlines": _md_inline_to_inlines(inline.children or []),
                        }]
                    })
                    j += 2  # advance past inline
                j += 1
            row = {"cells": cells}
            if in_thead:
                headers.append(row)
            else:
                rows.append(row)
            i = j
        i += 1
    table: dict[str, Any] = {"type": "table"}
    if headers:
        table["header_rows"] = headers
    table["rows"] = rows
    return i, table


def _md_inline_to_inlines(children: list[Any]) -> list[dict[str, Any]]:
    """markdown-it inline AST -> UDM inlines. Tracks open marks as a stack."""
    out: list[dict[str, Any]] = []
    marks: list[dict[str, Any]] = []
    for tok in children:
        t = tok.type
        if t == "text":
            text = tok.content or ""
            if text:
                inline: dict[str, Any] = {"type": "text", "text": text}
                if marks:
                    inline["marks"] = [{"type": m["type"]} for m in marks]
                out.append(inline)
        elif t == "softbreak" or t == "hardbreak":
            out.append({"type": "br"})
        elif t == "code_inline":
            inline = {"type": "text", "text": tok.content, "marks": [{"type": "code"}]}
            out.append(inline)
        elif t in ("strong_open",):
            marks.append({"type": "bold"})
        elif t in ("em_open",):
            marks.append({"type": "italic"})
        elif t == "s_open":
            marks.append({"type": "strike"})
        elif t in ("strong_close", "em_close", "s_close"):
            if marks:
                marks.pop()
        elif t == "link_open":
            href = ""
            for attr in tok.attrs or []:
                # attrs may be list of [name, value] or a dict
                if isinstance(attr, list) and len(attr) == 2 and attr[0] == "href":
                    href = attr[1]
                    break
            marks.append({"type": "link", "href": href})
        elif t == "link_close":
            if marks:
                marks.pop()
        elif t == "image":
            src = ""
            alt = ""
            for attr in tok.attrs or []:
                if isinstance(attr, list) and len(attr) == 2:
                    if attr[0] == "src":
                        src = attr[1]
                    elif attr[0] == "alt":
                        alt = attr[1]
            out.append({"type": "inline_image", "src": src, "alt": alt})
    return out


# ---- HTML soup -> UDM blocks --------------------------------------------


def _html_root_to_blocks(root: Tag) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for child in root.children:
        if isinstance(child, NavigableString):
            txt = str(child).strip()
            if txt:
                blocks.append({"type": "paragraph", "inlines": [{"type": "text", "text": txt}]})
            continue
        if not isinstance(child, Tag):
            continue
        b = _html_element_to_block(child)
        if isinstance(b, list):
            blocks.extend(b)
        elif b is not None:
            blocks.append(b)
    return blocks


def _html_element_to_block(el: Tag) -> dict[str, Any] | list[dict[str, Any]] | None:
    name = el.name.lower()
    if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
        return {
            "type": "heading",
            "level": int(name[1]),
            "inlines": _html_inlines(el),
        }
    if name == "p":
        return {"type": "paragraph", "inlines": _html_inlines(el)}
    if name == "hr":
        return {"type": "divider"}
    if name in ("ul", "ol"):
        items: list[dict[str, Any]] = []
        for li in el.find_all("li", recursive=False):
            items.append({"blocks": _html_root_to_blocks(li)})
        return {"type": "list", "ordered": name == "ol", "items": items}
    if name == "blockquote":
        return {"type": "quote", "blocks": _html_root_to_blocks(el)}
    if name == "pre":
        code_el = el.find("code")
        text = code_el.get_text() if code_el else el.get_text()
        lang = None
        if code_el and code_el.get("class"):
            for cls in code_el.get("class", []):
                if cls.startswith("language-"):
                    lang = cls[len("language-"):]
                    break
        return {"type": "code", "language": lang, "text": text}
    if name == "table":
        return _html_table_to_block(el)
    if name in ("div", "section", "article", "main", "body"):
        # Transparent container — flatten its children.
        return _html_root_to_blocks(el)
    # Inline-level element at block scope → wrap in a paragraph.
    return {"type": "paragraph", "inlines": _html_inlines(el)}


def _html_table_to_block(el: Tag) -> dict[str, Any]:
    headers: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    thead = el.find("thead")
    if thead:
        for tr in thead.find_all("tr", recursive=False):
            headers.append(_html_table_row(tr))
    tbody = el.find("tbody") or el
    for tr in tbody.find_all("tr", recursive=False):
        if thead and tr in thead.find_all("tr", recursive=False):
            continue
        rows.append(_html_table_row(tr))
    table: dict[str, Any] = {"type": "table"}
    if headers:
        table["header_rows"] = headers
    table["rows"] = rows
    return table


def _html_table_row(tr: Tag) -> dict[str, Any]:
    cells: list[dict[str, Any]] = []
    for cell in tr.find_all(["td", "th"], recursive=False):
        cells.append({"blocks": [{"type": "paragraph", "inlines": _html_inlines(cell)}]})
    return {"cells": cells}


def _html_inlines(el: Tag) -> list[dict[str, Any]]:
    """Flatten inline content of an element to UDM inlines."""
    out: list[dict[str, Any]] = []
    _walk_inline(el, [], out)
    return out


def _walk_inline(
    node: Any,
    marks: list[dict[str, Any]],
    out: list[dict[str, Any]],
) -> None:
    if isinstance(node, NavigableString):
        text = str(node)
        if text:
            inline: dict[str, Any] = {"type": "text", "text": text}
            if marks:
                inline["marks"] = [dict(m) for m in marks]
            out.append(inline)
        return
    if not isinstance(node, Tag):
        return
    name = node.name.lower()
    extra_mark: dict[str, Any] | None = None
    if name in ("strong", "b"):
        extra_mark = {"type": "bold"}
    elif name in ("em", "i"):
        extra_mark = {"type": "italic"}
    elif name == "u":
        extra_mark = {"type": "underline"}
    elif name in ("s", "del", "strike"):
        extra_mark = {"type": "strike"}
    elif name == "code":
        extra_mark = {"type": "code"}
    elif name == "sub":
        extra_mark = {"type": "sub"}
    elif name == "sup":
        extra_mark = {"type": "sup"}
    elif name == "a":
        extra_mark = {"type": "link", "href": node.get("href", "")}
    elif name == "br":
        out.append({"type": "br"})
        return
    elif name == "img":
        out.append({
            "type": "inline_image",
            "src": node.get("src", ""),
            "alt": node.get("alt", ""),
        })
        return

    next_marks = marks + ([extra_mark] if extra_mark else [])
    for child in node.children:
        _walk_inline(child, next_marks, out)
