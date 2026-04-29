# AllDocs

**Universal document editor and converter.** Open any document format. Edit it. Export to any format. Free, no signup, self-hostable.

---

## Status

Phase 0 — Foundation. Not yet usable.

## Vision

Most document tools handle one mode well: text editors do flow content, PDF tools do fixed layout, spreadsheet apps do sheets. AllDocs handles all four — flow, fixed, sheets, slides, and hybrids — through a single Universal Document Model (UDM).

The architectural cornerstone is [`docs/UDM_SPEC.md`](docs/UDM_SPEC.md). Read it before writing any adapter or editor code.

## Architecture

```
File  →  Importer  →  UDM  →  Browser Editor  →  UDM  →  Exporter  →  File
```

- **`core/`** — Rust. UDM types, validation, format detection, WASM target for client-side conversion.
- **`services/`** — Python microservices. Format-specific adapters using the best library for each format (PyMuPDF for PDF, python-docx/openpyxl/python-pptx for Office, LibreOffice headless for the long tail, Pandoc for text formats, PaddleOCR + Tesseract for scans, WeasyPrint + Playwright for HTML→PDF).
- **`web/`** — Next.js + TypeScript. TipTap (ProseMirror) for flow, Konva + canvas for fixed-mode editing, Univer for spreadsheets, PDF.js as fallback render.
- **`proto/`** — Shared schemas. UDM JSON Schema, gRPC definitions for service communication.
- **`infra/`** — Docker Compose for local dev and self-host, Kubernetes manifests for production, Cloudflare config.
- **`tests/fixtures/`** — Sample files in every supported format for round-trip regression testing.

Service boundaries communicate via NATS message bus. Files staged in MinIO (S3-compatible, ephemeral, 24h auto-delete). Redis for queues and rate-limit state. Postgres for audit logs only — no users table.

## Principles

1. **Free for everyone, no signup.** Cloudflare Turnstile + IP-based rate limits handle abuse without forcing accounts.
2. **Privacy-first.** Files auto-deleted after processing. Never used for training. Audit log proves it.
3. **Self-hostable.** Single `docker compose up` — your documents never leave your machine if you don't want them to.
4. **Lossless round-trip.** Import + edit + export should preserve every detail we possibly can. What we can't model yet is captured in opaque `extensions` blobs that survive round-trip.
5. **Production-grade in every phase.** No throwaway MVPs.

## Roadmap

| Phase | Weeks | Goal |
|-------|-------|------|
| 0 | 1–8   | Foundation: monorepo, CI, infra, UDM spec, file ingest, web shell |
| 1 | 9–20  | Read everything: all importers, OCR pipeline, read-only viewer |
| 2 | 21–32 | Edit flow: DOCX, MD, HTML, EPUB, ODT lossless round-trip |
| 3 | 33–48 | Edit fixed: PDF and slide editing, fonts, vector shapes |
| 4 | 49–64 | Sheets + slides: XLSX formulas, PPTX animations |
| 5 | 65–72 | Universal export: every-to-every quality matrix |
| 6 | 73+   | Scale, WASM client-side mode, observability, self-host package |

## Supported Formats (target)

| Category | Formats |
|----------|---------|
| Portable | PDF (1.0–2.0, PDF/A, PDF/UA), XPS, PostScript |
| Office (MS) | DOCX, DOC, XLSX, XLS, PPTX, PPT, RTF |
| OpenDocument | ODT, ODS, ODP, ODG |
| Apple iWork | Pages, Numbers, Keynote |
| Web | HTML, MHTML, XML |
| Markup | Markdown (CommonMark + GFM), AsciiDoc, reStructuredText, LaTeX |
| eBooks | EPUB (2 + 3), MOBI, AZW3, FB2 |
| Plain | TXT, CSV, TSV, JSON, YAML, TOML |
| Images | PNG, JPEG, WebP, TIFF, HEIC, SVG, BMP, GIF (as input → OCR; as embedded resource) |
| Scanned | Image-based PDFs and TIFFs (OCR via PaddleOCR + Tesseract) |

## Anti-Abuse

Free + no signup is a real attack surface. Defenses:
- Cloudflare Turnstile (background challenge, no clicking)
- Per-IP rate limits at the edge
- File size caps (bypass = self-host)
- Per-IP concurrency caps
- Ephemeral storage (24h max)
- Optional API key tier later for power users — rate-limit relief only, never a feature gate

## License

**TBD.** Choosing between:
- **MIT / Apache 2.0** — maximum permissive, anyone can build on it including paid services
- **AGPL-3.0** — enforces "free forever" by requiring hosted derivatives to share their changes

Decision pending. Opens a real tradeoff between adoption and defense of the free-for-all principle.

## Contributing

Currently in foundation phase. Not accepting external contributions until Phase 0 stabilizes.

## Tooling Required

- **Rust** (stable) — install via `rustup`
- **Python 3.11+** — for service development
- **Node 20+ and pnpm** — for web frontend
- **Docker + Docker Compose** — for local infra
- **LibreOffice** — bundled in the converter container, not required locally
