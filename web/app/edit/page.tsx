import type { Metadata } from "next";

import { HomeClient } from "@/components/HomeClient";
import { PageViewBeacon } from "@/components/PageViewBeacon";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "AllDocs · Editor",
  description:
    "Edit any document — PDF, DOCX, XLSX, PPTX, Markdown, HTML, EPUB, or image. No signup, no tracking.",
  robots: {
    // The editor surface itself isn't a landing page; let it be indexed
    // for direct linking but don't waste crawl budget here.
    index: true,
    follow: true,
  },
};

export default function EditPage() {
  return (
    <main className="min-h-screen">
      <PageViewBeacon page="editor" />
      <SiteHeader compact />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <HomeClient />
      </div>
      <SiteFooter />
    </main>
  );
}
