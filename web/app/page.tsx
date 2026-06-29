import type { Metadata } from "next";
import Link from "next/link";

import { EditorPreviewMock } from "@/components/EditorPreviewMock";
import { LiveCounters } from "@/components/LiveCounters";
import { PageViewBeacon } from "@/components/PageViewBeacon";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { SEO_LANDINGS } from "@/lib/seo-landings";

const HOME_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "AllDocs",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://getalldocs.com",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  description:
    "Free, no-signup online editor and converter for PDF, Word, Excel, PowerPoint, Markdown, HTML, EPUB, and images.",
};

export const metadata: Metadata = {
  title: "AllDocs — Edit any document, free, no signup",
  description:
    "Free online editor for PDF, DOCX, XLSX, PPTX, Markdown, HTML, EPUB, and images. No signup. No tracking. No training on your documents.",
  openGraph: {
    title: "AllDocs — Edit any document, free, no signup",
    description:
      "Free online editor for PDF, DOCX, XLSX, PPTX, Markdown, HTML, EPUB, and images. No signup. No tracking.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AllDocs — Edit any document, free, no signup",
    description:
      "Free online editor for PDF, DOCX, XLSX, PPTX, Markdown, HTML, EPUB, and images.",
  },
};

export default function LandingPage() {
  return (
    // compact header on the landing too — the hero below carries the
    // big tagline, so a slim sticky bar keeps the value-prop visible
    // without eating the scroll area.
    <main className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_JSON_LD) }}
      />
      <PageViewBeacon page="landing" />
      <SiteHeader compact />
      <Hero />
      <LiveCounters />
      <FormatGrid />
      <ValueProps />
      <PopularTasks />
      <Comparison />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}

function Hero() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 pt-6 sm:pt-8 pb-16 sm:pb-24 grid lg:grid-cols-2 gap-12 lg:gap-10 items-center">
        {/* Left: the pitch */}
        <div>
          <div className="font-mono text-[0.65rem] uppercase tracking-wider text-accent mb-6">
            free · no signup · no tracking
          </div>
          <h1 className="font-sans text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05]">
            Edit any document.{" "}
            <span className="text-muted">Without an account.</span>
          </h1>
          <p className="mt-6 max-w-xl font-sans text-lg text-fg/80 leading-relaxed">
            PDF, Word, Excel, PowerPoint, Markdown, HTML, EPUB, and
            scanned images — one editor, every format. Drop a file,
            edit it right in your browser, download it back.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/edit"
              className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-6 py-3 bg-accent text-accent-fg border border-accent hover:bg-accent-hover transition-colors"
            >
              try AllDocs free →
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-6 py-3 border border-border-strong text-fg hover:border-fg transition-colors"
            >
              how it works
            </Link>
          </div>
          <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-xl">
            <Stat number="0" label="signups" />
            <Stat number="8+" label="formats" />
            <Stat number="24h" label="auto-delete" />
            <Stat number="200MB" label="upload limit" />
          </div>
        </div>

        {/* Right: a glimpse of the product. Hidden on the smallest
            screens where it would just push the CTA below the fold. */}
        <div className="hidden sm:block">
          <EditorPreviewMock />
        </div>
      </div>
    </section>
  );
}

function Stat({ number, label }: { number: string; label: string }) {
  return (
    <div className="border-l border-border pl-3">
      <div className="font-sans text-xl text-fg font-semibold tabular-nums">
        {number}
      </div>
      <div className="font-mono text-[0.6rem] uppercase tracking-wider text-muted mt-0.5">
        {label}
      </div>
    </div>
  );
}

function FormatGrid() {
  const formats = [
    { name: "PDF", note: "edit, OCR, redact, fill forms, encrypt" },
    { name: "DOCX", note: "edit headings, lists, tables, marks" },
    { name: "XLSX", note: "edit cells, formulas, formats" },
    { name: "PPTX", note: "edit text + image shapes per slide" },
    { name: "Markdown", note: "round-trip with full CommonMark + GFM" },
    { name: "HTML", note: "sanitised import, idiomatic export" },
    { name: "EPUB", note: "import + export EPUB 3" },
    { name: "Images", note: "PNG · JPG · WebP · GIF · BMP · TIFF + OCR" },
  ];
  return (
    <section className="border-b border-border" id="formats">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
        <div className="label mb-2">supported formats</div>
        <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
          One editor. Every common document format.
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
          {formats.map((f) => (
            <div
              key={f.name}
              className="bg-surface p-5 hover:bg-elevated transition-colors"
            >
              <div className="font-mono text-sm font-bold uppercase tracking-wider text-accent">
                {f.name}
              </div>
              <div className="mt-2 font-sans text-sm text-fg/85 leading-relaxed">
                {f.note}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ValueProps() {
  return (
    <section className="border-b border-border" id="how-it-works">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
        <div className="label mb-2">how it works</div>
        <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
          Drop. Edit. Download. Done.
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-px bg-border border border-border">
          <Step
            n="01"
            title="Drop your file"
            body="Any of 8+ supported formats. Drag and drop, or click to pick. Up to 50MB. Encrypted PDFs prompt for a password."
          />
          <Step
            n="02"
            title="Edit it right in your browser"
            body="Click text to edit. Drag images to move. Resize, recolor, OCR scans, fill forms, add highlights and comments. No app to install."
          />
          <Step
            n="03"
            title="Download it back"
            body="Export to the original format, or a different one. Optionally protect a PDF with a password. We auto-delete the original after 24 hours."
          />
        </div>

        <div className="mt-16 grid grid-cols-1 lg:grid-cols-3 gap-px bg-border border border-border">
          <Prop
            label="privacy by default"
            title="We never train on your documents."
            body="No signup, no tracking cookies, no third-party analytics. Files auto-delete 24 hours after upload. Bug-report attachments are opt-in per submission, deleted within 30 days of resolution."
          />
          <Prop
            label="lossless round-trip"
            title="What you upload comes back unchanged."
            body="If you don't edit a file, the download is byte-identical to the original. We don't silently re-render the way other tools do. Patch-based editing preserves the original fonts and structure."
          />
          <Prop
            label="every format, one app"
            title="No more bouncing between converters."
            body="PDF, Office, ebook, web, and image formats all converge on a single Universal Document Model — so you can edit a DOCX and export as PDF, edit a PDF and export as Markdown, OCR an image and download as DOCX."
          />
        </div>
      </div>
    </section>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="bg-surface p-8">
      <div className="font-mono text-[0.65rem] uppercase tracking-wider text-subtle">
        step {n}
      </div>
      <h3 className="mt-2 font-sans text-xl font-semibold text-fg">{title}</h3>
      <p className="mt-3 font-sans text-sm text-fg/80 leading-relaxed">{body}</p>
    </div>
  );
}

function Prop({
  label,
  title,
  body,
}: {
  label: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-surface p-8">
      <div className="label">{label}</div>
      <h3 className="mt-2 font-sans text-lg font-semibold text-fg">{title}</h3>
      <p className="mt-3 font-sans text-sm text-fg/80 leading-relaxed">{body}</p>
    </div>
  );
}

function Comparison() {
  const rows: { feature: string; alldocs: string; others: string }[] = [
    { feature: "Signup required", alldocs: "no", others: "yes" },
    { feature: "Daily file limit", alldocs: "no", others: "yes" },
    { feature: "Edits live in your browser", alldocs: "yes", others: "varies" },
    { feature: "Trains ML on your docs", alldocs: "no", others: "often" },
    { feature: "Files auto-delete", alldocs: "24h", others: "varies" },
    { feature: "PDF + DOCX + XLSX + PPTX + EPUB + …", alldocs: "yes", others: "one tool per format" },
    { feature: "Cost", alldocs: "free", others: "$10–25/mo" },
  ];
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
        <div className="label mb-2">how we&apos;re different</div>
        <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
          A serious tool, given away free.
        </h2>
        <div className="border border-border bg-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-elevated">
                <th className="text-left px-4 py-3 font-mono text-xs uppercase tracking-wider text-muted">
                  &nbsp;
                </th>
                <th className="text-left px-4 py-3 font-mono text-xs uppercase tracking-wider text-accent">
                  AllDocs
                </th>
                <th className="text-left px-4 py-3 font-mono text-xs uppercase tracking-wider text-muted">
                  Typical online tools
                </th>
              </tr>
            </thead>
            <tbody className="font-sans">
              {rows.map((r, i) => (
                <tr key={i} className={i % 2 ? "" : "bg-bg/40"}>
                  <td className="px-4 py-3 text-fg/85">{r.feature}</td>
                  <td className="px-4 py-3 text-fg font-semibold">{r.alldocs}</td>
                  <td className="px-4 py-3 text-muted">{r.others}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function PopularTasks() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
        <div className="label mb-2">popular tasks</div>
        <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
          Jump straight to what you need.
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border border border-border">
          {SEO_LANDINGS.map((l) => (
            <Link
              key={l.slug}
              href={`/${l.slug}`}
              className="bg-surface p-5 hover:bg-elevated transition-colors"
            >
              <div className="font-mono text-sm font-bold uppercase tracking-wider text-accent">
                {l.eyebrow}
              </div>
              <div className="mt-2 font-sans text-sm text-fg/70 leading-relaxed">{l.h1}</div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section>
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-20 text-center">
        <h2 className="font-sans text-3xl sm:text-5xl font-bold tracking-tight max-w-3xl mx-auto leading-tight">
          Edit your first document.
          <br />
          <span className="text-muted">No signup. No email. No friction.</span>
        </h2>
        <div className="mt-10">
          <Link
            href="/edit"
            className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-8 py-4 bg-accent text-accent-fg border border-accent hover:bg-accent-hover transition-colors"
          >
            open the editor →
          </Link>
        </div>
        <div className="mt-6 font-mono text-xs text-subtle">
          drag a file in, edit it, download it back. that&apos;s it.
        </div>
      </div>
    </section>
  );
}
