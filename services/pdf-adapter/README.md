# pdf-adapter

AllDocs PDF format adapter — converts PDF documents to and from the Universal Document Model (UDM).

## What it does

- **Import**: PDF → UDM v0.1.0 (working, Phase 0)
- **Export**: UDM → PDF (TODO, Phase 3)

## Quickstart

```bash
# Install in editable mode
pip install -e .

# Convert a PDF to UDM JSON
pdf-adapter path/to/file.pdf -o file.udm.json --pretty
```

## Architecture

The importer reads a PDF with PyMuPDF and produces a `mode: "fixed"` UDM document containing:

- **Page geometry** — width, height in points
- **Text runs** — positioned glyphs with font, size, color
- **Image layers** — full transform (x, y, width, height) preserved
- **Font resources** — flagged as subset or full; family/weight/style detected heuristically
- **Image resources** — deduplicated by xref so multi-placement images share one resource

## Lessons baked in

This adapter is informed by `memory/project_alldocs_pdf_adapter.md` (real-world bugs found editing a Canva CV before AllDocs existed):

1. **Subset fonts** — every embedded font is checked and flagged with `_meta.subset`. The editor uses this to decide when to fall back to a full font for new glyphs.
2. **Off-page placements** — image rects are stored verbatim including negative coords; the editor decides "replace within frame" vs "replace whole asset".
3. **Multi-placement images** — the same `image_id` appears in multiple `ImageLayer`s. Removing one layer never deletes the resource.
4. **No bg sampling** — we don't sample pixel colors; we record structural layers only.

## Phase 3 (export) scope

When the export side lands, it must implement:
- Subset-aware text edit (fallback font on missing glyphs)
- Object-aware redaction (don't pixel-fill; redraw what's underneath)
- "Replace within frame" image edit with face-aware crop
- Optional content compaction after section removal
