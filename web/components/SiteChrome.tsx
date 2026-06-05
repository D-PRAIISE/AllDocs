import Link from "next/link";

import { PrivacyFooterLink } from "./PrivacyFooterLink";
import { ThemeToggle } from "./ThemeToggle";

/** Shared site header. `compact` hides the long tagline so editor-side
 * pages don't carry marketing copy. The brand always links home. */
export function SiteHeader({ compact = false }: { compact?: boolean }) {
  return (
    // Sticky so navigation + theme + editor link stay reachable when
    // the user scrolls through the landing page or a long document.
    // bg-surface/85 + backdrop-blur keeps the header readable over the
    // page content underneath without an opaque slab.
    <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-6">
        <div className="flex items-baseline justify-between gap-6 flex-wrap">
          <div className="flex items-baseline gap-3">
            <Link
              href="/"
              className="font-mono text-2xl font-bold tracking-tight uppercase hover:text-accent transition-colors"
              aria-label="AllDocs home"
            >
              AllDocs
            </Link>
            <span className="font-mono text-xs text-subtle">v0.1.0</span>
          </div>
          <nav className="flex items-center gap-4 font-mono text-xs uppercase tracking-wider">
            <Link
              href="/edit"
              className="text-muted hover:text-fg transition-colors"
            >
              Editor →
            </Link>
            <ThemeToggle />
          </nav>
        </div>
        {!compact && (
          <div className="mt-6 max-w-2xl text-fg/90 leading-relaxed">
            Universal document editor. Drop a PDF, DOCX, XLSX, PPTX,
            Markdown, HTML, EPUB, or image — view it, edit it, export
            it. No signup. No tracking.
          </div>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border mt-16">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-8 flex flex-wrap items-center justify-between gap-4 font-mono text-xs text-muted">
        <div>alldocs · universal document editor</div>
        <div className="flex items-center gap-4">
          <PrivacyFooterLink />
        </div>
      </div>
    </footer>
  );
}
