import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageViewBeacon } from "@/components/PageViewBeacon";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { getLanding, SEO_LANDINGS } from "@/lib/seo-landings";

const SITE_URL = "https://getalldocs.com";

// Only the configured slugs render; anything else 404s (no open-ended
// dynamic pages competing with the real routes).
export const dynamicParams = false;

export function generateStaticParams() {
  return SEO_LANDINGS.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const l = getLanding(slug);
  if (!l) return {};
  const url = `${SITE_URL}/${l.slug}`;
  return {
    title: l.title,
    description: l.description,
    alternates: { canonical: url },
    openGraph: {
      title: l.title,
      description: l.description,
      url,
      type: "website",
    },
    twitter: { card: "summary_large_image", title: l.title, description: l.description },
  };
}

export default async function SeoLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const l = getLanding(slug);
  if (!l) notFound();

  // Structured data: a SoftwareApplication for the product + an FAQPage
  // for the Q&A (eligible for rich results).
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "AllDocs",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: SITE_URL,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description: l.description,
      },
      {
        "@type": "FAQPage",
        mainEntity: l.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  return (
    <main className="min-h-screen">
      <PageViewBeacon page="landing" />
      <SiteHeader compact />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-6 lg:px-10 pt-6 sm:pt-8 pb-14 sm:pb-20">
          <div className="font-mono text-[0.65rem] uppercase tracking-wider text-accent mb-6">
            {l.eyebrow} · free · no signup
          </div>
          <h1 className="font-sans text-3xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] max-w-3xl">
            {l.h1}
          </h1>
          <p className="mt-6 max-w-2xl font-sans text-lg text-fg/80 leading-relaxed">
            {l.intro}
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/edit"
              className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-6 py-3 bg-accent text-accent-fg border border-accent hover:bg-accent-hover transition-colors"
            >
              open the editor →
            </Link>
            <Link
              href="/"
              className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-6 py-3 border border-border-strong text-fg hover:border-fg transition-colors"
            >
              about AllDocs
            </Link>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-px bg-border border border-border">
            {l.bullets.map((b) => (
              <div key={b.title} className="bg-surface p-8">
                <h2 className="font-sans text-xl font-semibold text-fg">{b.title}</h2>
                <p className="mt-3 font-sans text-sm text-fg/80 leading-relaxed">{b.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
          <div className="label mb-2">how it works</div>
          <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
            Drop. Edit. Download.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border border border-border">
            {[
              ["01", "Drop your file", "Drag it in or pick it — no account, no email."],
              ["02", "Edit in your browser", "Change text, images, forms; OCR scans; convert formats."],
              ["03", "Download it back", "Export to your format. Files auto-delete within 24 hours."],
            ].map(([n, t, b]) => (
              <div key={n} className="bg-surface p-8">
                <div className="font-mono text-[0.65rem] uppercase tracking-wider text-subtle">
                  step {n}
                </div>
                <h3 className="mt-2 font-sans text-lg font-semibold text-fg">{t}</h3>
                <p className="mt-2 font-sans text-sm text-fg/80 leading-relaxed">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
          <div className="label mb-2">questions</div>
          <h2 className="font-sans text-2xl sm:text-3xl font-bold tracking-tight mb-10">
            Frequently asked
          </h2>
          <div className="max-w-3xl divide-y divide-border border-y border-border">
            {l.faq.map((f) => (
              <div key={f.q} className="py-5">
                <h3 className="font-sans text-base font-semibold text-fg">{f.q}</h3>
                <p className="mt-2 font-sans text-sm text-fg/80 leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Related + CTA */}
      <section>
        <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-16">
          {l.related.length > 0 && (
            <>
              <div className="label mb-3">related</div>
              <div className="flex flex-wrap gap-2 mb-12">
                {l.related.map((slug) => {
                  const r = getLanding(slug);
                  if (!r) return null;
                  return (
                    <Link
                      key={slug}
                      href={`/${slug}`}
                      className="font-mono text-xs uppercase tracking-wider px-3 py-2 border border-border-strong text-muted hover:text-fg hover:border-fg transition-colors"
                    >
                      {r.eyebrow}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
          <h2 className="font-sans text-2xl sm:text-4xl font-bold tracking-tight max-w-2xl leading-tight">
            Try it now — no signup.
          </h2>
          <div className="mt-8">
            <Link
              href="/edit"
              className="inline-flex items-center font-mono text-sm uppercase tracking-wider px-8 py-4 bg-accent text-accent-fg border border-accent hover:bg-accent-hover transition-colors"
            >
              open the editor →
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
