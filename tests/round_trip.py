"""Round-trip test: synthetic.pdf -> UDM -> PDF; render both, side-by-side.

Run from repo root:
    python tests/round_trip.py [path/to/input.pdf]

Outputs land in tests/fixtures/round_trip_output/:
    doc.udm.json     — UDM produced by the importer
    assets/...       — extracted images and fonts
    output.pdf       — re-exported PDF from the UDM
    input_p1.png     — input rendered (page 1)
    output_p1.png    — re-exported rendered (page 1)
    side_by_side.png — visual diff side-by-side
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pymupdf
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
PYTHONPATH = REPO / "services" / "pdf-adapter" / "src"
DEFAULT_INPUT = REPO / "tests" / "fixtures" / "synthetic.pdf"
WORK_DIR = REPO / "tests" / "fixtures" / "round_trip_output"


def run_cli(*args: str) -> None:
    env = {**os.environ, "PYTHONPATH": str(PYTHONPATH)}
    subprocess.run(
        [sys.executable, "-m", "pdf_adapter.cli", *args],
        env=env,
        check=True,
    )


def render_page1(pdf: Path, out: Path, dpi: int = 100) -> tuple[int, int]:
    doc = pymupdf.open(str(pdf))
    pix = doc[0].get_pixmap(dpi=dpi)
    pix.save(str(out))
    size = (pix.width, pix.height)
    doc.close()
    return size


def main(argv: list[str]) -> int:
    input_pdf = Path(argv[1]) if len(argv) > 1 else DEFAULT_INPUT
    if not input_pdf.exists():
        print(f"error: input not found: {input_pdf}", file=sys.stderr)
        return 2

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    udm_path = WORK_DIR / "doc.udm.json"
    assets_dir = WORK_DIR / "assets"
    output_pdf = WORK_DIR / "output.pdf"
    in_render = WORK_DIR / "input_p1.png"
    out_render = WORK_DIR / "output_p1.png"
    sbs = WORK_DIR / "side_by_side.png"

    print(f"[1/4] importing {input_pdf.name} -> {udm_path.name}")
    run_cli(
        str(input_pdf),
        "-o",
        str(udm_path),
        "--assets-dir",
        str(assets_dir),
        "--assets-url-prefix",
        "assets",
    )

    print(f"[2/4] exporting {udm_path.name} -> {output_pdf.name}")
    run_cli("--export", str(udm_path), "-o", str(output_pdf))

    print(f"[3/4] rendering input page 1")
    in_size = render_page1(input_pdf, in_render)

    print(f"[4/4] rendering output page 1")
    out_size = render_page1(output_pdf, out_render)

    in_img = Image.open(in_render)
    out_img = Image.open(out_render)
    h = max(in_img.height, out_img.height)
    w = in_img.width + out_img.width + 20
    combined = Image.new("RGB", (w, h), "white")
    combined.paste(in_img, (0, 0))
    combined.paste(out_img, (in_img.width + 20, 0))
    combined.save(str(sbs))

    in_size_kb = input_pdf.stat().st_size // 1024
    out_size_kb = output_pdf.stat().st_size // 1024
    print()
    print(f"input  : {input_pdf.name}  {in_size_kb} KB  rendered {in_size[0]}x{in_size[1]}")
    print(f"output : {output_pdf.name}  {out_size_kb} KB  rendered {out_size[0]}x{out_size[1]}")
    print(f"side-by-side: {sbs}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
