"""Multi-language OCR test (lesson #15 follow-up).

Builds raster-only PDFs in different scripts, runs the importer with
`--ocr-lang LANG`, and verifies the recognised text is in the right
script. Validates the multi-language plumbing that landed in the PDF
debt sweep actually reaches Tesseract.

The language packs live at tests/fixtures/tessdata/. We point
Tesseract at that dir via ALLDOCS_TESSDATA for the duration of the
test so the system Tesseract install doesn't need admin to add packs.

Languages exercised here: chi_sim (CJK), deu (Latin). The plumbing is
the same for fra / ita / spa / por / rus / ara / jpn / kor / chi_tra —
add a stanza if you want to verify a specific one.

Run from repo root:
    python tests/ocr_multilang_test.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Force UTF-8 stdout so we can print recognised CJK / Arabic / Cyrillic
# characters without hitting Windows cp1252 encode errors.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Python 3.7+
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from pdf_adapter import _ocr  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402


FIXTURES_TESSDATA = REPO_ROOT / "tests" / "fixtures" / "tessdata"
# Point the OCR module at our bundled language packs.
os.environ["ALLDOCS_TESSDATA"] = str(FIXTURES_TESSDATA)


def _has_cjk(text: str) -> bool:
    for ch in text:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF:
            return True
    return False


def _has_german_diacritic(text: str) -> bool:
    """Tesseract recognising a German document should surface umlauts /
    eszett somewhere in the output."""
    return any(ch in "äöüÄÖÜß" for ch in text)


def _windows_font(candidates: tuple[str, ...]) -> Path | None:
    for p in candidates:
        f = Path(p)
        if f.exists():
            return f
    return None


def _cjk_font() -> Path | None:
    return _windows_font(
        (
            r"C:\Windows\Fonts\simsun.ttc",
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\simhei.ttf",
        )
    )


def _latin_font() -> Path | None:
    return _windows_font(
        (
            r"C:\Windows\Fonts\arial.ttf",
            r"C:\Windows\Fonts\verdana.ttf",
            r"C:\Windows\Fonts\segoeui.ttf",
        )
    )


def build_raster_pdf(path: Path, font_path: Path, lines: list[str]) -> bool:
    """Render text into a raster PDF (no native text — forces OCR)."""
    try:
        font = ImageFont.truetype(str(font_path), 80)
    except Exception:
        return False
    img = Image.new("RGB", (1700, 200 + 200 * len(lines)), "white")
    draw = ImageDraw.Draw(img)
    y = 80
    for line in lines:
        draw.text((80, y), line, fill=(0, 0, 0), font=font)
        y += 150
    doc = pymupdf.open()
    page = doc.new_page(width=img.width * 0.72, height=img.height * 0.72)
    png_path = path.with_suffix(".png")
    img.save(png_path)
    page.insert_image(page.rect, filename=str(png_path))
    doc.save(str(path))
    doc.close()
    png_path.unlink(missing_ok=True)
    return True


def run_language(
    label: str,
    lang_code: str,
    font_path: Path | None,
    lines: list[str],
    check: callable,
) -> bool:
    print(f"  Language: {label} (--ocr-lang {lang_code})")
    if font_path is None:
        print(f"    SKIP: no system font available to build the fixture")
        return True
    pack = FIXTURES_TESSDATA / f"{lang_code}.traineddata"
    if not pack.exists():
        print(f"    SKIP: language pack missing: {pack}")
        return True
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / f"{lang_code}.pdf"
        if not build_raster_pdf(src, font_path, lines):
            print("    SKIP: failed to build the fixture")
            return True
        udm = import_pdf(
            src,
            source_url=f"/{lang_code}.pdf",
            enable_ocr=True,
            ocr_lang=lang_code,
        )
        chunks = []
        for page in udm["content"]["pages"]:
            for layer in page.get("layers", []):
                if layer.get("type") != "text":
                    continue
                for run in layer.get("runs", []):
                    if run.get("ocr"):
                        chunks.append(run.get("text", ""))
        all_text = " ".join(chunks).strip()
        if not all_text:
            print("    [FAIL] importer produced no OCR runs at all")
            return False
        print(f"    recognized: {all_text[:80]!r}")
        if not check(all_text):
            print(f"    [FAIL] script check failed — pack didn't take effect")
            return False
        print(f"    [PASS] {label} OCR via --ocr-lang {lang_code}")
        return True


def main() -> int:
    print("Multi-language OCR test\n")
    if not _ocr.tesseract_available():
        print("  SKIP: Tesseract binary not found")
        return 0

    ok = True
    ok = run_language(
        "Chinese (Simplified)",
        "chi_sim",
        _cjk_font(),
        ["你好世界", "测试中文识别"],
        _has_cjk,
    ) and ok
    print()
    ok = run_language(
        "German",
        "deu",
        _latin_font(),
        ["Schöne Grüße", "Tschüß"],
        _has_german_diacritic,
    ) and ok
    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
