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
    related: ["edit-word", "edit-pdf", "edit-scanned-pdf"],
  },
  {
    slug: "edit-scanned-pdf",
    title: "Edit a Scanned PDF Online — Free, No Signup | AllDocs",
    description:
      "Edit a scanned or image-only PDF free. OCR turns the scan into editable text you can change in place — then download it back as a PDF. No signup.",
    eyebrow: "edit scanned pdf",
    h1: "Edit a scanned PDF. Free, no signup.",
    intro:
      "A scanned PDF is just a picture — normally you can't edit it. AllDocs runs OCR on import so the words become editable text right on the page. Fix a name, a date, a value, then download it back as a PDF.",
    bullets: [
      {
        title: "Scan becomes editable text",
        body: "OCR recognises the words so you can click and retype them — no retyping the whole document.",
      },
      {
        title: "Only your edits change",
        body: "Everything you don't touch stays exactly as the original scan; edited words are re-drawn cleanly in place.",
      },
      {
        title: "Stays a PDF",
        body: "Edit in place and export back to PDF — no converting to Word and losing the layout.",
      },
    ],
    faq: [
      {
        q: "How do I edit text in a scanned PDF?",
        a: "Import it — AllDocs OCRs the scan automatically. Click any word to edit it, then download. " + NO_SIGNUP,
      },
      {
        q: "Will it change parts I didn't edit?",
        a: "No. Only the runs you actually change are re-rendered; the rest of the page is the untouched scan.",
      },
      {
        q: "Is OCR perfect?",
        a: "OCR is very good but not flawless on faint or stylised text — you can fix any misread by editing the text directly.",
      },
    ],
    related: ["edit-pdf", "ocr-pdf", "pdf-to-word"],
  },
  {
    slug: "fill-pdf-forms",
    title: "Fill PDF Forms Online — Free, No Signup | AllDocs",
    description:
      "Fill out PDF forms online free — type into fields, tick checkboxes, choose radio options, add text anywhere. No signup, no watermark. Download the filled PDF.",
    eyebrow: "fill pdf forms",
    h1: "Fill a PDF form online. Free.",
    intro:
      "Type into form fields, tick checkboxes, pick radio options — or just drop text anywhere the form needs it. Then download the completed PDF. No account, no watermark.",
    bullets: [
      {
        title: "Real fields + free text",
        body: "Fill built-in AcroForm fields, or add your own text box anywhere on a flat form that has none.",
      },
      {
        title: "Checkboxes & radios",
        body: "Tick boxes and choose radio options directly on the page.",
      },
      {
        title: "Download & done",
        body: "Export the filled form as a PDF — no signup, no watermark, files auto-delete in 24 hours.",
      },
    ],
    faq: [
      {
        q: "Can I fill a form that has no fillable fields?",
        a: "Yes — add your own text, checkboxes, and marks anywhere on the page, even if the PDF is a flat/scanned form.",
      },
      {
        q: "Is it free?",
        a: "Completely. " + NO_SIGNUP,
      },
      {
        q: "Do I need to print and scan?",
        a: "No — fill it entirely on screen and download a clean PDF.",
      },
    ],
    related: ["edit-pdf", "add-text-to-pdf", "password-protect-pdf"],
  },
  {
    slug: "add-text-to-pdf",
    title: "Add Text to a PDF — Free, No Signup | AllDocs",
    description:
      "Add text to a PDF online free — insert a note, a date, a signature line, or fill a blank. Choose font, size, colour. No signup, no watermark.",
    eyebrow: "add text to pdf",
    h1: "Add text to a PDF. Free, no signup.",
    intro:
      "Click anywhere on the page and type — add a note, a date, a missing detail, or fill a blank. Pick the font, size, and colour to match. Download it back as a PDF.",
    bullets: [
      {
        title: "Type anywhere",
        body: "Drop a text box at any spot on any page — no fields required.",
      },
      {
        title: "Match the look",
        body: "Choose sans/serif/mono, size, bold/italic, colour, and opacity so it fits the document.",
      },
      {
        title: "Free & private",
        body: "No signup or watermark; your file auto-deletes within 24 hours and is never used for training.",
      },
    ],
    faq: [
      {
        q: "Can I choose the font and colour?",
        a: "Yes — sans, serif, or mono, with size, bold, italic, colour, and opacity controls.",
      },
      {
        q: "Does it leave a watermark?",
        a: "Never. " + NO_SIGNUP,
      },
      {
        q: "Can I add text to a scanned PDF?",
        a: "Yes — add text on top of any page, scanned or not.",
      },
    ],
    related: ["edit-pdf", "fill-pdf-forms", "highlight-pdf"],
  },
  {
    slug: "highlight-pdf",
    title: "Highlight & Annotate a PDF — Free, No Signup | AllDocs",
    description:
      "Highlight, comment, and draw on a PDF online free. Mark up documents in your browser. No signup, no watermark. Download the annotated PDF.",
    eyebrow: "highlight pdf",
    h1: "Highlight & annotate a PDF. Free.",
    intro:
      "Mark up any PDF — highlight lines, leave sticky-note comments, draw freehand. Review and annotate right in your browser, then download the marked-up PDF.",
    bullets: [
      {
        title: "Highlight & comment",
        body: "Drag to highlight text and drop comments where feedback belongs.",
      },
      {
        title: "Draw freehand",
        body: "Sketch, circle, or underline with the ink tool for quick markup.",
      },
      {
        title: "No signup",
        body: "Annotate free with no account or watermark; files auto-delete in 24 hours.",
      },
    ],
    faq: [
      {
        q: "Can I highlight scanned PDFs too?",
        a: "Yes — highlight and annotate over any page, scanned or native.",
      },
      {
        q: "Is it really free?",
        a: "Yes. " + NO_SIGNUP,
      },
      {
        q: "Can I download the annotated file?",
        a: "Yes — export a PDF with your highlights, comments, and drawings baked in.",
      },
    ],
    related: ["edit-pdf", "add-text-to-pdf", "redact-pdf"],
  },
  {
    slug: "redact-pdf",
    title: "Redact / Black Out a PDF — Free, No Signup | AllDocs",
    description:
      "Redact a PDF free — black out names, numbers, and sensitive info before sharing. No signup, no watermark. Download the redacted PDF.",
    eyebrow: "redact pdf",
    h1: "Redact a PDF. Free, no signup.",
    intro:
      "Cover names, account numbers, or any sensitive detail before you share a document. Drop opaque boxes over the parts to hide, then download a clean redacted PDF.",
    bullets: [
      {
        title: "Black out anything",
        body: "Place solid boxes over the exact areas you need to hide, on any page.",
      },
      {
        title: "Works on scans too",
        body: "On a scanned PDF the covered pixels are gone from the exported file.",
      },
      {
        title: "Private by design",
        body: "No signup, no tracking; your upload auto-deletes within 24 hours and is never used for training.",
      },
    ],
    faq: [
      {
        q: "Is the redaction free?",
        a: "Yes, free with no signup or watermark. " + NO_SIGNUP,
      },
      {
        q: "Can I redact a scanned document?",
        a: "Yes — cover the sensitive regions; the exported PDF no longer shows those pixels.",
      },
      {
        q: "Do you keep my file?",
        a: "No — uploads auto-delete within 24 hours and are never used to train anything.",
      },
    ],
    related: ["edit-pdf", "highlight-pdf", "password-protect-pdf"],
  },
  {
    slug: "password-protect-pdf",
    title: "Password-Protect a PDF — Free, No Signup | AllDocs",
    description:
      "Add a password to a PDF free — encrypt it so only people with the password can open it. No signup, no watermark. Download the protected PDF.",
    eyebrow: "protect pdf",
    h1: "Password-protect a PDF. Free.",
    intro:
      "Encrypt a PDF so only people with the password can open it. Edit first if you need to, then export a password-protected file — no account, no watermark.",
    bullets: [
      {
        title: "Strong encryption",
        body: "Protect the exported PDF with a password so it can't be opened without it.",
      },
      {
        title: "Edit, then protect",
        body: "Make any changes first, then add the password on export in one step.",
      },
      {
        title: "Free & no signup",
        body: "No account required; files auto-delete within 24 hours and are never used for training.",
      },
    ],
    faq: [
      {
        q: "Is adding a PDF password free?",
        a: "Yes — free, no signup, no watermark. " + NO_SIGNUP,
      },
      {
        q: "Can I also remove a password?",
        a: "If you can open a protected PDF (you know its password), you can export an unprotected copy.",
      },
      {
        q: "What encryption is used?",
        a: "The exported PDF is encrypted with AES-256.",
      },
    ],
    related: ["edit-pdf", "redact-pdf", "fill-pdf-forms"],
  },
];

export function getLanding(slug: string): SeoLanding | undefined {
  return SEO_LANDINGS.find((l) => l.slug === slug);
}
