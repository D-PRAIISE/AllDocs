"""End-to-end test for PDF passthrough export (Approach C).

Imports a PDF with --source-url, runs the exporter, and asserts the
output bytes equal the source bytes. Run from repo root:

    python tests/passthrough_test.py [path/to/test.pdf]

Defaults to CSCA + Hygeia + Kara's CV from ~/Downloads so we cover the
three problem families that motivated this work.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PDF_ADAPTER_SRC = REPO_ROOT / "services" / "pdf-adapter" / "src"
sys.path.insert(0, str(PDF_ADAPTER_SRC))

from pdf_adapter._passthrough import compute_fingerprint  # noqa: E402
from pdf_adapter.exporter import export_pdf  # noqa: E402
from pdf_adapter.importer import import_pdf  # noqa: E402

DEFAULT_FIXTURES = [
    Path.home() / "Downloads" / "CSCA Chemistry Examination Syllabus-2025.pdf",
    Path.home() / "Downloads" / "Hygeia HMO Corporate Registration FORM 2025..pdf",
    Path.home() / "Downloads" / "Kara's CV (Updated v2).pdf",
]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_one(src: Path) -> tuple[bool, str]:
    if not src.exists():
        return False, f"missing fixture: {src}"

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        # Mirror the layout the web import route produces:
        #   <session>/source.pdf
        #   <session>/doc.udm.json
        #   <session>/assets/
        # base_dir at export time = td_path (so /source.pdf resolves).
        source_in = td_path / "source.pdf"
        source_in.write_bytes(src.read_bytes())
        assets_dir = td_path / "assets"
        source_url = "/source.pdf"

        udm = import_pdf(
            source_in,
            assets_dir=assets_dir,
            assets_url_prefix="/assets",
            source_url=source_url,
        )
        pt = udm.get("metadata", {}).get("passthrough")
        if pt is None:
            return False, "no passthrough block in UDM"

        # Sanity: fingerprint stable across JSON serialization.
        round_tripped = json.loads(json.dumps(udm))
        if compute_fingerprint(round_tripped) != pt["fingerprint"]:
            return False, "fingerprint unstable across JSON round-trip"

        output = td_path / "output.pdf"
        export_pdf(round_tripped, output, base_dir=td_path)

        src_sha = sha256_of(source_in)
        out_sha = sha256_of(output)
        if src_sha != out_sha:
            return False, f"bytes differ: src={src_sha[:8]} out={out_sha[:8]}"
        return True, f"byte-identical ({source_in.stat().st_size} bytes)"


def run_edit_invalidates(src: Path) -> tuple[bool, str]:
    """Confirm that mutating the UDM text breaks passthrough so the render
    path takes over. If this fails we'd silently emit stale source after
    an edit."""
    if not src.exists():
        return False, f"missing fixture: {src}"

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        source_in = td_path / "source.pdf"
        source_in.write_bytes(src.read_bytes())

        udm = import_pdf(
            source_in,
            assets_dir=td_path / "assets",
            assets_url_prefix="/assets",
            source_url="/source.pdf",
        )

        # Inject a text mutation on the first run we find.
        mutated = False
        for page in udm["content"]["pages"]:
            for layer in page.get("layers", []):
                if layer.get("type") != "text":
                    continue
                for run in layer.get("runs", []):
                    if run.get("text"):
                        run["text"] = run["text"] + "_EDIT"
                        mutated = True
                        break
                if mutated:
                    break
            if mutated:
                break
        if not mutated:
            return False, "no text runs found to mutate"

        output = td_path / "output.pdf"
        export_pdf(udm, output, base_dir=td_path)

        # If passthrough had fired, output would equal source.
        if sha256_of(output) == sha256_of(source_in):
            return False, "passthrough fired despite edit — fingerprint not strict enough"
        return True, "edit correctly invalidated passthrough"


def main(argv: list[str]) -> int:
    fixtures = [Path(p) for p in argv[1:]] if len(argv) > 1 else DEFAULT_FIXTURES

    print(f"Passthrough round-trip test on {len(fixtures)} fixture(s)\n")
    all_pass = True
    for src in fixtures:
        ok, msg = run_one(src)
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {src.name}: {msg}")
        if not ok:
            all_pass = False

    print("\nEdit-invalidation check:\n")
    for src in fixtures:
        ok, msg = run_edit_invalidates(src)
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {src.name}: {msg}")
        if not ok:
            all_pass = False

    print()
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
