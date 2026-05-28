import { HomeClient } from "@/components/HomeClient";
import { PrivacyFooterLink } from "@/components/PrivacyFooterLink";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <HomeClient />
      </div>
      <SiteFooter />
    </main>
  );
}

function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-baseline justify-between gap-6">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-2xl font-bold tracking-tight uppercase">
              AllDocs
            </h1>
            <span className="font-mono text-xs text-subtle">v0.1.0</span>
          </div>
          <nav className="flex items-center gap-4 font-mono text-xs uppercase tracking-wider">
            <ThemeToggle />
            <a
              href="https://github.com/D-PRAIISE/AllDocs"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-fg transition-colors"
            >
              GitHub →
            </a>
            <span className="text-subtle">AGPL-3.0</span>
          </nav>
        </div>
        <div className="mt-6 max-w-2xl text-fg/90 leading-relaxed">
          Universal document editor. Drop a PDF or DOCX, view it, edit it,
          export it back. No signup. No upload limit. Open source.
        </div>
        <div className="mt-3 font-mono text-xs text-muted">
          UDM v0.1.0 · spec at <span className="text-fg/80">docs/UDM_SPEC.md</span> ·
          schema at <span className="text-fg/80">proto/udm.schema.json</span>
        </div>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border mt-16">
      <div className="mx-auto max-w-6xl px-6 py-8 flex flex-wrap items-center justify-between gap-4 font-mono text-xs text-muted">
        <div>
          alldocs · universal document model v0.1.0 · agpl-3.0
        </div>
        <div className="flex items-center gap-4">
          <PrivacyFooterLink />
          <a
            href="https://github.com/D-PRAIISE/AllDocs"
            target="_blank"
            rel="noreferrer"
            className="hover:text-fg transition-colors"
          >
            source ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
