"""
Bundled metric-compatible fallback fonts for the PDF exporter.

Three Apache-2.0-licensed families ship in pdf_adapter/fonts/. They are
visually metric-compatible with the common embedded font families found
in real-world PDFs and are used in preference to PyMuPDF's base-14 stock
fonts when an extracted subset can't be reused:

    Arimo    -> Arial / Helvetica / Trebuchet / Tahoma / Calibri / Verdana
                and any other sans-serif family.
    Tinos    -> Times New Roman / Times / Georgia / Cambria / serif fallback.
    Cousine  -> Courier New / Courier / Consolas / mono fallback.

Each file is the Latin-subset build (~20 KB) hosted by the fontsource
project on jsdelivr. Sufficient for Western European text. CJK and other
non-Latin scripts still fall through to base-14 (or, in v0.2, will pick
up a bundled Noto Sans CJK).

See PDF-adapter lesson #13 for the fallback policy.
"""
from __future__ import annotations

from pathlib import Path

BUNDLED_DIR = Path(__file__).resolve().parent / "fonts"

# Case-insensitive substring patterns. Order is irrelevant — we just check
# each pattern. First class hit wins (mono > serif > sans).
_SERIF_PATTERNS = (
    "serif",
    "times",
    "georgia",
    "cambria",
    "garamond",
    "baskerville",
    "palatino",
    "minion",
    "caslon",
    "didot",
    "bookman",
    "century",
    "tinos",
)
_MONO_PATTERNS = (
    "mono",
    "courier",
    "consolas",
    "monaco",
    "menlo",
    "inconsolata",
    "source code",
    "fira code",
    "ibm plex mono",
    "jetbrains",
    "cousine",
)


def classify_family(family: str) -> str:
    """Return 'mono', 'serif', or 'sans' for a given font family name."""
    lower = family.lower()
    for pat in _MONO_PATTERNS:
        if pat in lower:
            return "mono"
    for pat in _SERIF_PATTERNS:
        if pat in lower:
            return "serif"
    return "sans"


def resolve_fallback(family: str, weight: int, style: str) -> Path | None:
    """Pick the closest bundled font file for a given family/weight/style.

    Returns the absolute path to a .ttf in pdf_adapter/fonts/, or None if
    no suitable file exists (e.g., the fonts dir wasn't shipped or the
    requested style is unavailable).
    """
    if not BUNDLED_DIR.exists():
        return None

    base = {"serif": "tinos", "mono": "cousine", "sans": "arimo"}[classify_family(family)]

    is_bold = int(weight) >= 600
    is_italic = style in ("italic", "oblique")

    if is_bold and is_italic:
        order = ("BoldItalic", "Bold", "Italic", "Regular")
    elif is_bold:
        order = ("Bold", "BoldItalic", "Regular", "Italic")
    elif is_italic:
        order = ("Italic", "BoldItalic", "Regular", "Bold")
    else:
        order = ("Regular", "Italic", "Bold", "BoldItalic")

    for variant in order:
        path = BUNDLED_DIR / f"{base}-{variant}.ttf"
        if path.exists():
            return path
    return None
