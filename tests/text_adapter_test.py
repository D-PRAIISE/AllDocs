"""Markdown / HTML adapter round-trip test.

Builds a small Markdown document with the major block types, imports
it, exports it back to Markdown, re-imports the export, and verifies
the second UDM matches the first (structural equality of the block
tree). Then does the same for HTML.

Run from repo root:
    python tests/text_adapter_test.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "services" / "text-adapter" / "src"))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from text_adapter import (  # noqa: E402
    export_html,
    export_markdown,
    import_html,
    import_markdown,
)


MD_FIXTURE = """\
# AllDocs

A universal document editor.

## Features

- Free forever
- **No** signup
- Round-trips *Markdown* and `HTML`

## Code

```python
print("hi")
```

> A blockquote with **bold** and *italic*.

| Lang | Note |
| --- | --- |
| MD | round-trips |
| HTML | sanitized |

---

A final paragraph with [a link](https://example.org).
"""


def _block_types(udm: dict) -> list[str]:
    return [b.get("type") for b in udm["content"]["blocks"]]


def test_markdown_roundtrip() -> bool:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "in.md"
        src.write_text(MD_FIXTURE, encoding="utf-8")
        udm1 = import_markdown(src)
        print(f"  imported blocks: {_block_types(udm1)}")

        out_md = td_path / "out.md"
        export_markdown(udm1, out_md)
        udm2 = import_markdown(out_md)

        ok = True
        if _block_types(udm1) != _block_types(udm2):
            print(f"  [FAIL] block sequence drifted: {_block_types(udm1)} vs {_block_types(udm2)}")
            ok = False
        else:
            print("  [PASS] block sequence preserved across MD round-trip")
        if udm1["metadata"].get("title") != udm2["metadata"].get("title"):
            print(f"  [FAIL] title drifted: {udm1['metadata'].get('title')!r} vs {udm2['metadata'].get('title')!r}")
            ok = False
        else:
            print(f"  [PASS] title preserved: {udm1['metadata'].get('title')!r}")
        return ok


def test_html_export_then_import() -> bool:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "in.md"
        src.write_text(MD_FIXTURE, encoding="utf-8")
        udm1 = import_markdown(src)
        out_html = td_path / "out.html"
        export_html(udm1, out_html)
        udm2 = import_html(out_html)
        print(f"  HTML re-imported blocks: {_block_types(udm2)}")
        if _block_types(udm1) != _block_types(udm2):
            print("  [FAIL] block sequence drifted in MD->HTML->UDM trip")
            return False
        print("  [PASS] MD → HTML → UDM preserved block sequence")
        return True


def test_html_sanitization() -> bool:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        src = td_path / "evil.html"
        src.write_text(
            """<h1>Hi</h1>
<p>safe <a href="https://ok">link</a></p>
<script>alert('xss')</script>
<img src="x" onerror="alert(1)">
""",
            encoding="utf-8",
        )
        udm = import_html(src)
        flat = json.dumps(udm)
        if "<script" in flat or "onerror" in flat or "alert(1)" in flat:
            print("  [FAIL] sanitization let dangerous content through")
            return False
        print("  [PASS] script / onerror stripped on HTML import")
        return True


def main() -> int:
    print("Text adapter (Markdown + HTML) round-trip test\n")
    ok = True
    print("Test 1: Markdown round-trip preserves block structure")
    ok = test_markdown_roundtrip() and ok
    print()
    print("Test 2: Markdown → HTML → UDM preserves block structure")
    ok = test_html_export_then_import() and ok
    print()
    print("Test 3: HTML import sanitises script / event handlers")
    ok = test_html_sanitization() and ok
    print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
