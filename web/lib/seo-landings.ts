/**
 * Per-format / per-task SEO landing pages.
 *
 * Each entry becomes a statically-generated page at /<slug> that targets
 * a specific high-intent search ("edit pdf online free", "convert pdf to
 * word", …) and funnels to the editor. One shared template renders them
 * (see app/[slug]/page.tsx), so adding a page = adding an entry here.
 *
 * Copy stays honest to the product: free, no signup, no tracking, files
 * auto-delete, we never train on your documents.
 */

export interface SeoLanding {
  slug: string;
  /** <title> — lead with the keyword. */
  title: string;
  /** Meta description (~150 chars). */
  description: string;
  eyebrow: string;
  h1: string;
  /** Hero sub-paragraph. */
  intro: string;
  /** Three value props. */
  bullets: { title: string; body: string }[];
  /** FAQ — also emitted as FAQPage structured data for rich results. */
  faq: { q: string; a: string }[];
  /** Related format chips shown near the bottom. */
  related: string[];
}

const NO_SIGNUP =
  "No account, no email, no watermark. Your file is processed in your browser session and auto-deleted within 24 hours — and we never train on your documents.";

export const SEO_LANDINGS: SeoLanding[] = [
  {
    slug: "edit-pdf",
    title: "Edit PDF Online — Free, No Signup | AllDocs",
    description:
      "Edit any PDF online free — change text, add images, fill forms, OCR scans, highlight and redact. No signup, no watermark. Download it back as PDF.",
    eyebrow: "edit pdf",
    h1: "Edit a PDF online. Free, no signup.",
    intro:
      "Open any PDF right in your browser and edit it like a document — fix a typo, swap an image, fill a form, highlight a line, OCR a scan. Then download it back as a PDF.",
    bullets: [
      {
        title: "Edit real text, not annotations",
        body: "Click any line and retype it. AllDocs edits the underlying text — it isn't a sticky-note layer on top.",
      },
      {
        title: "Scanned PDF? OCR built in",
        body: "Image-only PDFs are run through OCR on import, so even a scan becomes selectable, searchable, editable text.",
      },
      {
        title: "Forms, highlights, images, redaction",
        body: "Fill form fields, drop in images, draw highlights, black out sensitive content — all in one editor.",
      },
    ],
    faq: [
      {
        q: "Is editing PDFs really free?",
        a: "Yes — completely free with no signup, no watermark, and no daily limit. " + NO_SIGNUP,
      },
      {
        q: "Can I edit a scanned PDF?",
        a: "Yes. Scanned/image-only PDFs are OCR'd automatically on import, turning the picture of text into editable text you can change and search.",
      },
      {
        q: "Will the layout stay intact?",
        a: "AllDocs keeps fonts, positions, and images so your edits drop into the original layout instead of reflowing the page.",
      },
    ],
    related: ["pdf-to-word", "ocr-pdf", "word-to-pdf"],
  },
  {
    slug: "pdf-to-word",
    title: "Convert PDF to Word (DOCX) — Free, No Signup | AllDocs",
    description:
      "Convert PDF to an editable Word (DOCX) document free. Keep text, tables, and images. No signup, no watermark. Edit in your browser and download.",
    eyebrow: "pdf → word",
    h1: "Convert PDF to Word. Free, no signup.",
    intro:
      "Turn a PDF into an editable Word (DOCX) document — text, headings, lists, tables, and images carried across. Tweak it in the browser first, then download the DOCX.",
    bullets: [
      {
        title: "Editable, not flattened",
        body: "You get real Word content — paragraphs, headings, lists, and tables — not a page of images.",
      },
      {
        title: "Scans become text",
        body: "A scanned PDF is OCR'd first, so the Word file has selectable text instead of pictures.",
      },
      {
        title: "Review before you download",
        body: "Open the result in the editor, fix anything, then export to DOCX — or to PDF, Markdown, or HTML.",
      },
    ],
    faq: [
      {
        q: "Does it keep tables and images?",
        a: "Yes — AllDocs preserves text, headings, lists, tables, and images when converting PDF to Word.",
      },
      {
        q: "Is there a watermark or signup?",
        a: "Neither. " + NO_SIGNUP,
      },
      {
        q: "Can I convert a scanned PDF to Word?",
        a: "Yes. Image-only PDFs are OCR'd on import so the resulting Word document contains editable text.",
      },
    ],
    related: ["edit-pdf", "word-to-pdf", "ocr-pdf"],
  },
  {
    slug: "word-to-pdf",
    title: "Convert Word to PDF — Free, No Signup | AllDocs",
    description:
      "Convert a Word (DOCX) document to PDF free, with layout intact. No signup, no watermark. Optionally edit first, then download your PDF.",
    eyebrow: "word → pdf",
    h1: "Convert Word to PDF. Free, no signup.",
    intro:
      "Drop in a DOCX and export a clean PDF — fonts, headings, lists, tables, and images preserved. Make a quick edit first if you need to, then download.",
    bullets: [
      {
        title: "Faithful layout",
        body: "Headings, lists, tables, and images carry over so the PDF looks like your document.",
      },
      {
        title: "Edit on the way through",
        body: "Fix a typo or swap a value before exporting — no need to reopen Word.",
      },
      {
        title: "Password-protect optional",
        body: "Encrypt the exported PDF with a password if it's something private.",
      },
    ],
    faq: [
      {
        q: "Is converting Word to PDF free?",
        a: "Yes, free with no signup or watermark. " + NO_SIGNUP,
      },
      {
        q: "Can I password-protect the PDF?",
        a: "Yes — you can optionally encrypt the exported PDF with a password.",
      },
      {
        q: "Does formatting stay the same?",
        a: "AllDocs preserves fonts, headings, lists, tables, and images so the PDF matches your DOCX.",
      },
    ],
    related: ["pdf-to-word", "edit-pdf", "edit-word"],
  },
  {
    slug: "ocr-pdf",
    title: "OCR a PDF or Image Online — Free, No Signup | AllDocs",
    description:
      "Run OCR on a scanned PDF or image free to extract editable, searchable text. No signup, no watermark. Edit the result and download as PDF, Word, or text.",
    eyebrow: "ocr",
    h1: "OCR a scanned PDF or image. Free.",
    intro:
      "Turn a scan or photo of a document into real text. AllDocs runs OCR on import, so the page becomes selectable, searchable, and editable — then export it however you like.",
    bullets: [
      {
        title: "Scan → editable text",
        body: "Tesseract OCR turns image-only pages into text you can select, search, and change in place.",
      },
      {
        title: "Keeps the original look",
        body: "Recognised text sits on the original page layout, so it still looks like your document.",
      },
      {
        title: "Export anywhere",
        body: "Download as a searchable PDF, an editable Word file, Markdown, or plain text.",
      },
    ],
    faq: [
      {
        q: "What file types can I OCR?",
        a: "Scanned PDFs and images (PNG, JPG, WebP, GIF, BMP, TIFF). They're OCR'd automatically on import.",
      },
      {
        q: "Is the OCR free?",
        a: "Yes — free, no signup, no watermark. " + NO_SIGNUP,
      },
      {
        q: "How accurate is it?",
        a: "AllDocs uses Tesseract, the widely-used open OCR engine. Clear scans recognise very well; you can fix anything by editing the text directly.",
      },
    ],
    related: ["edit-pdf", "pdf-to-word", "image-to-text"],
  },
  {
    slug: "edit-word",
    title: "Edit Word Documents Online — Free, No Signup | AllDocs",
    description:
      "Edit Word (DOCX) documents online free — headings, lists, tables, and text. No signup, no watermark. Export to DOCX, PDF, Markdown, or HTML.",
    eyebrow: "edit word",
    h1: "Edit Word documents online. Free.",
    intro:
      "Open a DOCX in your browser and edit it — headings, paragraphs, lists, tables — no Office install, no account. Export back to Word, or to PDF, Markdown, or HTML.",
    bullets: [
      {
        title: "No Office, no install",
        body: "Edit DOCX straight in the browser on any device — nothing to download.",
      },
      {
        title: "Convert as you export",
        body: "Save back as DOCX, or turn it into a PDF, Markdown, or HTML in one click.",
      },
      {
        title: "Private by default",
        body: "No signup, no tracking; your file auto-deletes within 24 hours and is never used for training.",
      },
    ],
    faq: [
      {
        q: "Do I need Microsoft Word?",
        a: "No — AllDocs edits DOCX in your browser, no Office install or account required.",
      },
      {
        q: "What can I export to?",
        a: "DOCX, PDF, Markdown, or HTML.",
      },
      {
        q: "Is it free?",
        a: "Yes. " + NO_SIGNUP,
      },
    ],
    related: ["word-to-pdf", "edit-excel", "edit-powerpoint"],
  },
  {
    slug: "edit-excel",
    title: "Edit Excel (XLSX) Online — Free, No Signup | AllDocs",
    description:
      "Edit Excel spreadsheets (XLSX) online free — cells, formulas, and formatting. No signup, no watermark. Download back as XLSX.",
    eyebrow: "edit excel",
    h1: "Edit Excel spreadsheets online. Free.",
    intro:
      "Open an XLSX in the browser and edit cells, formulas, and formatting — no account, no install. Download it back as a spreadsheet when you're done.",
    bullets: [
      {
        title: "Cells, formulas, formats",
        body: "Edit values and formulas and keep number/format styling intact.",
      },
      {
        title: "Works on any device",
        body: "No spreadsheet app required — it runs in your browser.",
      },
      {
        title: "Free and private",
        body: "No signup or watermark; files auto-delete within 24 hours and are never used for training.",
      },
    ],
    faq: [
      {
        q: "Do my formulas survive?",
        a: "Yes — AllDocs preserves cell formulas and formatting when you edit and re-export XLSX.",
      },
      {
        q: "Is it free?",
        a: "Yes, free with no signup or watermark. " + NO_SIGNUP,
      },
      {
        q: "Can I open large spreadsheets?",
        a: "Uploads up to 200 MB are supported, which covers most spreadsheets comfortably.",
      },
    ],
    related: ["edit-word", "edit-powerpoint", "edit-pdf"],
  },
];

export function getLanding(slug: string): SeoLanding | undefined {
  return SEO_LANDINGS.find((l) => l.slug === slug);
}
