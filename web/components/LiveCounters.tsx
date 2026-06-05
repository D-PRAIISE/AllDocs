"use client";

import { useEffect, useState } from "react";

interface Stats {
  visitors_today: number;
  visitors_week: number;
  docs_today: number;
  docs_total_window: number;
  docs_edited_window: number;
  pdfs_edited_window: number;
}

/** Social-proof strip on the landing. Pulls aggregated counters from
 * /api/stats (which reads the audit log). Renders nothing until the
 * fetch resolves so we never show a flash of zeros, and hides itself
 * entirely while the numbers are still trivially small (avoids the
 * "0 documents edited" look on a fresh deploy). */
export function LiveCounters() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((r) => (r.ok ? (r.json() as Promise<Stats>) : null))
      .then((d) => {
        if (!cancelled) setStats(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  // Don't show the strip until there's something worth showing — a
  // brand-new instance with single-digit counts looks worse with the
  // banner than without it.
  const meaningful =
    stats.docs_total_window >= 10 || stats.visitors_week >= 25;
  if (!meaningful) return null;

  const items: { value: number; label: string }[] = [
    { value: stats.visitors_week, label: "visitors this week" },
    { value: stats.docs_total_window, label: "documents processed" },
    { value: stats.pdfs_edited_window, label: "pdfs edited" },
  ];

  return (
    <section className="border-b border-border bg-elevated/40">
      <div className="mx-auto max-w-[1600px] px-6 lg:px-10 py-8 grid grid-cols-3 gap-4">
        {items.map((it) => (
          <div key={it.label} className="text-center">
            <div className="font-sans text-2xl sm:text-4xl font-bold tabular-nums text-fg">
              {formatCount(it.value)}
            </div>
            <div className="mt-1 font-mono text-[0.6rem] sm:text-xs uppercase tracking-wider text-muted">
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
