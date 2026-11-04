"""Line-fragment merge test.

PDF producers split a line far more finely than it reads. Word writes
every SPACE at a different point size from the words around it — no
visual difference, a space has no glyph — which shattered one real
certificate's headline into 14 separately-clickable runs. Users tapping
a line to edit it got a word instead.

The importer merges adjacent same-style fragments into one run, treating
a whitespace-only span as compatible with whatever it sits between, and
leaves anything past half an em alone so tab stops and columns survive.

Locks in all three properties, plus the trail (_meta.spans) the patch
exporter needs to redact every fragment rather than just the first.

Run from repo root:
    python tests/span_merge_test.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "pdf-adapter" / "src"))

import pymupdf  # noqa: E402

from pdf_adapter.exporter import export_pdf  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402

FONT = "helv"
# Word's actual pattern: words at one size, the spaces between them at
# another. Same font, same colour, visually identical.
WORD_PATTERN = [("RE:", 14.2), (" ", 16.0), ("OGANIRU", 14.2), (" ", 16.0), ("GRACE", 14.2)]
EXPECTED = "RE: OGANIRU GRACE"


def build_fixture(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=240)

    # Line 1 — the Word quirk. Each call is its own text op.
    x = 72.0
    for txt, size in WORD_PATTERN:
        page.insert_text((x, 100), txt, fontsize=size, fontname=FONT)
        x += pymupdf.get_text_length(txt, fontname=FONT, fontsize=size)

    # Line 2 — a column layout. Same style, but a wide deliberate gap
    # that carries meaning through position, not characters.
    page.insert_text((72, 160), "PCV", fontsize=12, fontname=FONT)
    page.insert_text((320, 160), "42%", fontsize=12, fontname=FONT)

    doc.save(str(path))
    doc.close()


def runs_of(udm: dict) -> list[dict]:
    out: list[dict] = []
    for page in udm["content"]["pages"]:
        for layer in page.get("layers", []):
            if layer.get("type") == "text":
                out.extend(layer.get("runs", []))
    return out


def main() -> int:
    failures = 0
    print("Line-fragment merge test\n")
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "frag.pdf"
        build_fixture(src)

        udm = import_pdf(src, source_url="/frag.pdf", enable_ocr=False)
        runs = runs_of(udm)
        texts = [r.get("text", "") for r in runs]
        print(f"  imported runs: {texts!r}")

        # 1. the fragmented line collapses to one run
        merged = next((r for r in runs if r.get("text", "").strip() == EXPECTED), None)
        if merged is None:
            print(f"  [FAIL] fragments didn't merge into {EXPECTED!r}")
            failures += 1
        else:
            print(f"  [PASS] {len(WORD_PATTERN)} fragments merged into one run")

            # 2. the trail back to the source spans is recorded
            parts = (merged.get("_meta") or {}).get("spans") or []
            if len(parts) < 2:
                print(f"  [FAIL] merged run records no _meta.spans trail: {parts!r}")
                failures += 1
            elif "".join(p["text"] for p in parts) != merged["text"]:
                print("  [FAIL] _meta.spans doesn't reconstruct the run text")
                failures += 1
            else:
                print(f"  [PASS] _meta.spans records {len(parts)} source fragments")

        # 3. a deliberate column gap is NOT merged
        if any("PCV" in t and "42%" in t for t in texts):
            print("  [FAIL] merged across a column gap — alignment would be lost")
            failures += 1
        else:
            print("  [PASS] wide column gap left unmerged")

        # 4. no characters invented or dropped
        src_chars = "".join(pymupdf.open(str(src))[0].get_text().split())
        got_chars = "".join("".join(texts).split())
        if src_chars != got_chars:
            print(f"  [FAIL] text drift: source {src_chars!r} vs runs {got_chars!r}")
            failures += 1
        else:
            print("  [PASS] character content identical to source")

        # 5. editing a merged run round-trips: every fragment redacted,
        #    replacement present. This is what broke when merged runs had
        #    no trail — only the first fragment got redacted.
        if merged is not None:
            merged["text"] = "RE: ADEBAYO GRACE"
            merged.setdefault("_meta", {})["edited"] = True
            out = td_path / "edited.pdf"
            export_pdf(udm, out, base_dir=td_path)
            text = pymupdf.open(str(out))[0].get_text()
            if "ADEBAYO" not in text:
                print(f"  [FAIL] replacement text missing from export: {text!r}")
                failures += 1
            elif "OGANIRU" in text:
                print(f"  [FAIL] a fragment of the old text survived: {text!r}")
                failures += 1
            else:
                print("  [PASS] merged-run edit round-trips cleanly")

    print()
    print("ALL PASS" if failures == 0 else f"{failures} FAILURE(S)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
