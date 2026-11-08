"""Per-import caches for the two things PyMuPDF makes us pay for twice.

Profiling a real 27-page, 74-image manual showed 43.7s of import, and
over half of it was work already done:

  * ``page.get_text("dict")`` re-parses the whole page into a fresh
    textpage — ~0.3s on a dense A4 page, and the importer's single
    largest cost. Three passes want it: the text extractor, the
    prose check that decides whether form auto-detect should fire, and
    the label pass that names detected fields. 27 pages produced **65**
    textpage builds, 19.3s in total.

  * ``doc.extract_image(xref)`` re-encodes the image to PNG on every
    call. Both the asset writer and the resource builder ask for the
    same xrefs, so 74 images cost **148** encodes, 15.5s in total.

Neither pass can simply be dropped — they each need the data. They just
need it once. These caches live here rather than in importer.py because
_form_detect is imported *by* importer, so it cannot import back.

Scope is one import run. ``reset()`` is called when an import starts, so
a second document in the same process (the test suite does this) can
never see the first one's pages or xrefs.
"""

from __future__ import annotations

from typing import Any

import pymupdf

_text_dicts: dict[int, dict[str, Any]] = {}
_images: dict[int, dict[str, Any]] = {}


def reset() -> None:
    """Drop everything. Call at the start of each import."""
    _text_dicts.clear()
    _images.clear()


def text_dict(page: pymupdf.Page) -> dict[str, Any]:
    """``page.get_text("dict")``, built once per page.

    Raises whatever get_text raises — every caller already guards it,
    and swallowing here would turn a parse failure into an empty page.
    """
    key = page.number
    hit = _text_dicts.get(key)
    if hit is None:
        hit = page.get_text("dict")
        _text_dicts[key] = hit
    return hit


def extract_image(doc: pymupdf.Document, xref: int) -> dict[str, Any]:
    """``doc.extract_image(xref)``, decoded once per xref."""
    hit = _images.get(xref)
    if hit is None:
        hit = doc.extract_image(xref)
        _images[xref] = hit
    return hit
