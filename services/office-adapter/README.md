# office-adapter

AllDocs Office format adapter — DOCX <-> UDM (flow mode).

XLSX (sheet mode) and PPTX (slides mode) will land in v0.2 in the same package.

## What it does

- **Import**: DOCX → UDM v0.1.0 (mode=flow), captures headings, paragraphs,
  bulleted/numbered lists, tables, and inline marks (bold/italic/underline/
  strikethrough/super/subscript/color).
- **Export**: UDM (flow) → DOCX, inverse mapping.

## Quickstart

```bash
# Install in editable mode
pip install -e services/office-adapter

# Convert a DOCX to UDM JSON
office-adapter input.docx -o input.udm.json --pretty

# Round-trip the UDM back to DOCX
office-adapter --export input.udm.json -o roundtrip.docx
```

## Out of scope for v0.1

- Image extraction from inline pictures (data_ref stays opaque)
- Headers, footers, page numbers
- Custom paragraph/character styles
- Track changes, comments
- Equations and math content
- Hyperlinks (rendered as plain text in v0.1)

These all land in v0.2 with the spec extension.
