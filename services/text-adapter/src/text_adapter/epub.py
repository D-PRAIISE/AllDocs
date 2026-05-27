"""
EPUB <-> UDM flow adapter.

EPUB is a zip containing:
  - mimetype (first entry, uncompressed, ASCII "application/epub+zip")
  - META-INF/container.xml — points at the OPF file
  - OEBPS/<book>.opf — manifest of all files + spine reading order +
    Dublin Core metadata (title, author, etc.)
  - one or more XHTML files (chapters) listed in the spine
  - optional CSS / image / font assets

We:
  - Import: concatenate every spine XHTML, reusing import_html for
    each chapter, into one UDM flow document. Pull title + authors
    from OPF Dublin Core metadata.
  - Export: serialize the flow doc as a single-chapter EPUB with the
    minimum viable manifest + spine + container.xml. Splitting by H1
    boundaries into multiple chapters is a future enhancement.

EPUB 3 supports more (NCX vs nav, font embedding, fixed-layout, etc.)
— v1 emits a valid EPUB 3 that opens in Apple Books / Calibre /
readium.
"""
from __future__ import annotations

import hashlib
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import bleach
from bs4 import BeautifulSoup

from .exporter import _blocks_to_html, _html_escape
from .importer import (
    UDM_VERSION,
    _ALLOWED_ATTRS,
    _ALLOWED_TAGS,
    _first_h1,
    _html_root_to_blocks,
)

EPUB_MIME = "application/epub+zip"

# XML namespaces we read from container.xml + OPF.
_NS_CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container"
_NS_OPF = "http://www.idpf.org/2007/opf"
_NS_DC = "http://purl.org/dc/elements/1.1/"


def import_epub(path: str | Path) -> dict[str, Any]:
    """Read an EPUB file and produce a UDM v0.1 flow document."""
    path = Path(path)
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()

    blocks: list[dict[str, Any]] = []
    title: str | None = None
    authors: list[str] = []
    subject: str | None = None

    with zipfile.ZipFile(BytesIO(raw)) as zf:
        opf_path = _find_opf_path(zf)
        if not opf_path:
            raise ValueError("EPUB has no parseable container.xml / OPF")

        with zf.open(opf_path) as opf_file:
            opf_bytes = opf_file.read()
        manifest, spine, meta = _parse_opf(opf_bytes)
        title = meta.get("title")
        if meta.get("creator"):
            authors = [meta["creator"]]
        subject = meta.get("subject")

        # Resolve relative paths inside the EPUB.
        opf_dir = str(Path(opf_path).parent).replace("\\", "/")
        if opf_dir == ".":
            opf_dir = ""

        # Walk the spine in reading order; each entry references a
        # manifest item by idref.
        for idref in spine:
            href = manifest.get(idref)
            if not href:
                continue
            inner_path = _join_zip(opf_dir, href)
            try:
                with zf.open(inner_path) as chap_file:
                    chap_bytes = chap_file.read()
            except KeyError:
                continue
            chapter_blocks = _xhtml_bytes_to_blocks(chap_bytes)
            blocks.extend(chapter_blocks)

    if not title:
        title = _first_h1(blocks)

    metadata: dict[str, Any] = {
        "source_format": {"mime": EPUB_MIME, "extension": "epub"},
        "source_hash": sha256,
    }
    if title:
        metadata["title"] = title
    if authors:
        metadata["authors"] = authors
    if subject:
        metadata["subject"] = subject

    return {
        "udm_version": UDM_VERSION,
        "id": str(uuid.uuid4()),
        "mode": "flow",
        "metadata": metadata,
        "resources": {"fonts": [], "images": [], "styles": [], "colors": []},
        "content": {"blocks": blocks},
    }


def export_epub(udm: dict[str, Any], output_path: str | Path) -> None:
    """UDM flow → minimal EPUB 3."""
    if udm.get("mode") != "flow":
        raise ValueError(f"EPUB export requires flow UDM; got mode={udm.get('mode')!r}")
    blocks = (udm.get("content") or {}).get("blocks") or []
    meta = udm.get("metadata") or {}
    title = meta.get("title") or "Untitled"
    authors = meta.get("authors") or []
    creator = authors[0] if authors else "AllDocs"
    book_id = f"urn:uuid:{udm.get('id') or uuid.uuid4()}"
    language = meta.get("language") or "en"

    chapter_body = _blocks_to_html(blocks, indent=4)
    chapter_xhtml = _chapter_xhtml(title, chapter_body)
    nav_xhtml = _nav_xhtml(title)
    opf = _opf_xml(book_id, title, creator, language)
    container_xml = _CONTAINER_XML

    out = Path(output_path)
    # EPUB requires "mimetype" as the FIRST entry, uncompressed (stored),
    # so a reader can detect the format from the leading bytes.
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr(
            zipfile.ZipInfo("mimetype"),
            EPUB_MIME,
            compress_type=zipfile.ZIP_STORED,
        )
        zf.writestr("META-INF/container.xml", container_xml, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/chapter.xhtml", chapter_xhtml, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/nav.xhtml", nav_xhtml, compress_type=zipfile.ZIP_DEFLATED)


# ---- import helpers ----------------------------------------------------


def _find_opf_path(zf: zipfile.ZipFile) -> str | None:
    """container.xml at META-INF/container.xml lists the OPF rootfile."""
    try:
        with zf.open("META-INF/container.xml") as f:
            data = f.read()
    except KeyError:
        return None
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None
    ns = {"c": _NS_CONTAINER}
    rootfile = root.find(".//c:rootfile", ns)
    if rootfile is None:
        return None
    return rootfile.get("full-path")


def _parse_opf(opf_bytes: bytes) -> tuple[dict[str, str], list[str], dict[str, str]]:
    """Parse an OPF: returns (manifest id->href, spine idrefs, dc-metadata)."""
    try:
        root = ET.fromstring(opf_bytes)
    except ET.ParseError:
        return {}, [], {}

    ns = {"opf": _NS_OPF, "dc": _NS_DC}

    manifest: dict[str, str] = {}
    for item in root.findall("opf:manifest/opf:item", ns):
        item_id = item.get("id") or ""
        href = item.get("href") or ""
        if item_id and href:
            manifest[item_id] = href

    spine: list[str] = []
    for itemref in root.findall("opf:spine/opf:itemref", ns):
        idref = itemref.get("idref")
        if idref:
            spine.append(idref)

    dc: dict[str, str] = {}
    for tag, key in (("title", "title"), ("creator", "creator"), ("subject", "subject")):
        el = root.find(f"opf:metadata/dc:{tag}", ns)
        if el is not None and el.text:
            dc[key] = el.text.strip()
    return manifest, spine, dc


def _join_zip(dirpath: str, href: str) -> str:
    if not dirpath:
        return href
    # zip paths use forward slashes; normalise away "./" / "../".
    parts = []
    for piece in (dirpath.split("/") + href.split("/")):
        if piece in ("", "."):
            continue
        if piece == "..":
            if parts:
                parts.pop()
            continue
        parts.append(piece)
    return "/".join(parts)


def _xhtml_bytes_to_blocks(data: bytes) -> list[dict[str, Any]]:
    """Re-uses the HTML importer's sanitize+walk pipeline for each
    spine chapter."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    # Strip XML declaration / doctype so BS4 sees the body directly.
    raw_soup = BeautifulSoup(text, "html.parser")
    body_node = raw_soup.body
    body_html = body_node.decode_contents() if body_node else text
    clean = bleach.clean(
        body_html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=["http", "https", "mailto", "data"],
        strip=True,
        strip_comments=True,
    )
    soup = BeautifulSoup(clean, "html.parser")
    return _html_root_to_blocks(soup)


# ---- export helpers ----------------------------------------------------


_CONTAINER_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>
"""


def _chapter_xhtml(title: str, body_html: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8"/>\n'
        f"  <title>{_html_escape(title)}</title>\n"
        "</head>\n"
        "<body>\n"
        f"{body_html}\n"
        "</body>\n"
        "</html>\n"
    )


def _nav_xhtml(title: str) -> str:
    """EPUB 3 navigation document. Required by spec; lists the
    chapter(s) in the spine."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n'
        "<head>\n"
        '  <meta charset="utf-8"/>\n'
        "  <title>Contents</title>\n"
        "</head>\n"
        "<body>\n"
        '  <nav epub:type="toc" id="toc">\n'
        "    <h1>Contents</h1>\n"
        "    <ol>\n"
        f'      <li><a href="chapter.xhtml">{_html_escape(title)}</a></li>\n'
        "    </ol>\n"
        "  </nav>\n"
        "</body>\n"
        "</html>\n"
    )


def _opf_xml(book_id: str, title: str, creator: str, language: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="en">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'    <dc:identifier id="BookId">{_html_escape(book_id)}</dc:identifier>\n'
        f"    <dc:title>{_html_escape(title)}</dc:title>\n"
        f"    <dc:creator>{_html_escape(creator)}</dc:creator>\n"
        f"    <dc:language>{_html_escape(language)}</dc:language>\n"
        '    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>\n'
        "  </metadata>\n"
        "  <manifest>\n"
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
        '    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>\n'
        "  </manifest>\n"
        '  <spine>\n'
        '    <itemref idref="chapter"/>\n'
        "  </spine>\n"
        "</package>\n"
    )
