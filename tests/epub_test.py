"""EPUB round-trip test.

Build a small flow UDM in-memory, export it to EPUB, re-import the
EPUB, and verify the block structure survives. Also verify the EPUB
is a valid zip with the mimetype entry first + uncompressed.

Run from repo root:
    python tests/epub_test.py
"""
from __future__ import annotations

import sys
import tempfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "text-adapter" / "src"))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from text_adapter import (  # noqa: E402
    export_epub,
    import_epub,
    import_markdown,
)


MD_FIXTURE = """\
# Quiet Country Road

A small EPUB to validate the round-trip.

## Chapter notes

- one
- two with **bold**

> blockquote sample

```python
print("hello")
```
"""


def _block_types(udm: dict) -> list[str]:
    return [b.get("type") for b in udm["content"]["blocks"]]


def test_epub_roundtrip() -> bool:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "in.md"
        src.write_text(MD_FIXTURE, encoding="utf-8")
        udm1 = import_markdown(src)
        # Add a synthetic author to verify Dublin Core round-trip.
        udm1["metadata"]["authors"] = ["Test Author"]

        out_epub = td_path / "out.epub"
        export_epub(udm1, out_epub)

        # Structural sanity on the zip itself.
        with zipfile.ZipFile(out_epub) as zf:
            names = zf.namelist()
            if "mimetype" not in names:
                print("  [FAIL] mimetype entry missing from EPUB")
                return False
            first = zf.infolist()[0]
            if first.filename != "mimetype":
                print("  [FAIL] mimetype is not the first entry "
                      f"(got {first.filename!r})")
                return False
            if first.compress_type != zipfile.ZIP_STORED:
                print("  [FAIL] mimetype entry must be STORED (uncompressed)")
                return False
            if "META-INF/container.xml" not in names or "OEBPS/content.opf" not in names:
                print("  [FAIL] container.xml / OPF missing")
                return False
        print("  [PASS] EPUB zip structure conforms to spec")

        udm2 = import_epub(out_epub)
        if _block_types(udm1) != _block_types(udm2):
            print(f"  [FAIL] block sequence drifted: "
                  f"{_block_types(udm1)} vs {_block_types(udm2)}")
            return False
        print(f"  [PASS] block sequence preserved across EPUB round-trip "
              f"({_block_types(udm1)})")

        if udm2["metadata"].get("title") != udm1["metadata"].get("title"):
            print(f"  [FAIL] title drifted: {udm1['metadata'].get('title')!r} vs "
                  f"{udm2['metadata'].get('title')!r}")
            return False
        if udm2["metadata"].get("authors") != ["Test Author"]:
            print(f"  [FAIL] author lost: {udm2['metadata'].get('authors')!r}")
            return False
        print(f"  [PASS] Dublin Core title + creator round-tripped")

        return True


def main() -> int:
    print("EPUB round-trip test\n")
    ok = test_epub_roundtrip()
    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
