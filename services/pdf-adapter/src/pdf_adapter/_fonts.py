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
project on jsdelivr. Sufficient for Western European text.

CJK fallback (lesson #13): when the text being inserted contains CJK
codepoints, we probe the OS for a real CJK font (Microsoft YaHei,
Hiragino Sans, Noto Sans CJK, …) and use that instead of the
Latin-only bundled fallback. Bundling Noto Sans CJK would add ~10-40MB
per script to the repo; system-font probing is far cheaper and
typically works on real machines.

See PDF-adapter lesson #13 for the fallback policy.
"""
from __future__ import annotations

import os
import sys
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
    # "sans" must be checked before the serif patterns: the generic CSS
    # name "sans-serif" (and "sans serif") contains the substring
    # "serif", so a naive serif scan misclassifies every sans font —
    # which is how OCR-inserted text rendered in a Times-like serif.
    if "sans" in lower:
        return "sans"
    for pat in _SERIF_PATTERNS:
        if pat in lower:
            return "serif"
    return "sans"


# Family-name substrings that indicate a CJK font in the source PDF.
# When we see one of these we route to the system CJK font even if the
# text-detection signal is absent (e.g. full re-render where we only
# have the font name, not the text it's used with).
_CJK_FAMILY_PATTERNS = (
    "cjk",
    "noto sans", "noto serif",  # commonly used for CJK variants
    "simsun", "simhei", "songti", "fangsong", "kaiti", "yahei", "yuanti",
    "jhenghei", "mingliu", "pmingliu", "biaukai", "dfkai",
    "hiragino", "yu gothic", "yu mincho", "meiryo", "ms gothic", "ms mincho",
    "kozuka",
    "malgun", "nanum", "batang", "gulim", "dotum",
    "wenquanyi",
)


def family_is_cjk(family: str) -> bool:
    lower = family.lower()
    return any(pat in lower for pat in _CJK_FAMILY_PATTERNS)


def text_has_cjk(text: str) -> bool:
    """True if any character in ``text`` is in a CJK Unicode range.

    Covers Chinese (simplified + traditional), Japanese (hiragana,
    katakana, kanji), Korean (hangul + hanja). Not exhaustive — picks
    up the common-text ranges; rare extensions / private-use blocks
    aren't worth the false-positive risk.
    """
    for ch in text:
        cp = ord(ch)
        if (
            0x3040 <= cp <= 0x30FF        # Hiragana + Katakana
            or 0x3400 <= cp <= 0x4DBF      # CJK Extension A
            or 0x4E00 <= cp <= 0x9FFF      # CJK Unified Ideographs
            or 0xAC00 <= cp <= 0xD7AF      # Hangul Syllables
            or 0xF900 <= cp <= 0xFAFF      # CJK Compatibility Ideographs
            or 0xFF66 <= cp <= 0xFF9F      # Half-width Katakana
        ):
            return True
    return False


# Candidate CJK font paths per OS — first-found wins. We probe these on
# first request and cache the result.
_CJK_CANDIDATES_WINDOWS = (
    r"C:\Windows\Fonts\msyh.ttc",       # Microsoft YaHei (SC)
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\msjh.ttc",       # Microsoft JhengHei (TC)
    r"C:\Windows\Fonts\meiryo.ttc",     # Meiryo (JP)
    r"C:\Windows\Fonts\YuGothM.ttc",    # Yu Gothic (JP)
    r"C:\Windows\Fonts\malgun.ttf",     # Malgun Gothic (KR)
    r"C:\Windows\Fonts\simsun.ttc",     # SimSun (SC)
    r"C:\Windows\Fonts\NotoSansCJK-Regular.ttc",
)
_CJK_CANDIDATES_DARWIN = (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Apple SD Gothic Neo.ttc",
)
_CJK_CANDIDATES_LINUX = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
    "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
)

_cjk_cache: tuple[Path | None, ...] = ()


def find_cjk_font() -> Path | None:
    """Probe the OS for a CJK-capable font. Caches the result."""
    global _cjk_cache
    if _cjk_cache:
        return _cjk_cache[0]
    if sys.platform.startswith("win"):
        candidates = _CJK_CANDIDATES_WINDOWS
    elif sys.platform == "darwin":
        candidates = _CJK_CANDIDATES_DARWIN
    else:
        candidates = _CJK_CANDIDATES_LINUX
    # Allow override via env var for unusual installs / Docker layers
    # that mount fonts to non-standard paths.
    override = os.environ.get("ALLDOCS_CJK_FONT")
    if override and Path(override).exists():
        result: Path | None = Path(override)
    else:
        result = None
        for c in candidates:
            p = Path(c)
            if p.exists():
                result = p
                break
    _cjk_cache = (result,)
    return result


def resolve_fallback(
    family: str,
    weight: int,
    style: str,
    text: str | None = None,
) -> Path | None:
    """Pick the closest font file for a given family/weight/style.

    If ``text`` is supplied and contains CJK codepoints, prefers an OS
    CJK font (Microsoft YaHei, Hiragino, Noto CJK, …) — the bundled
    Latin-only fallback would render those codepoints as .notdef boxes.

    Returns the absolute path to a font file, or None if no suitable
    file is found.
    """
    needs_cjk = (text and text_has_cjk(text)) or family_is_cjk(family)
    if needs_cjk:
        cjk = find_cjk_font()
        if cjk is not None:
            return cjk
        # No CJK font on this machine — fall through to the bundled
        # Latin fallback. Glyphs will be .notdef but at least we don't
        # crash; the user can install a CJK font or set
        # ALLDOCS_CJK_FONT to fix.

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
