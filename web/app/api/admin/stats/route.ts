/**
 * GET /api/admin/stats — admin-gated, full analytics.
 *
 * One pass over the whole audit log, bucketed into rolling time
 * windows (last hour / 24h / 7d / 30d / 365d / all-time). For each
 * window we count unique visitors (distinct hashed IPs), imports, and
 * exports. Plus a 30-day per-day series for the sparkline and
 * exports-by-format + operational counters.
 *
 * 30s in-memory cache so opening the dashboard doesn't re-scan the
 * log on every refresh.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { adminConfigured, isAdminRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 30 * 1000;

// Rolling windows, in milliseconds. "all" = no lower bound.
const WINDOWS: { key: string; ms: number | null }[] = [
  { key: "hour", ms: 60 * 60 * 1000 },
  { key: "day", ms: 24 * 60 * 60 * 1000 },
  { key: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { key: "all", ms: null },
];

interface WindowCounts {
  visitors: number;
  imports: number;
  exports: number;
}

let cache: { at: number; data: unknown } | null = null;

function auditDir(): string {
  return resolve(process.cwd(), "..", "audit");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!adminConfigured()) {
    return NextResponse.json({ error: "admin not configured" }, { status: 503 });
  }
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const dir = auditDir();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    /* no audit dir yet */
  }

  // Per-window accumulators. Visitors tracked as Sets for distinctness.
  const visitorSets: Record<string, Set<string>> = {};
  const imports: Record<string, number> = {};
  const exports: Record<string, number> = {};
  for (const w of WINDOWS) {
    visitorSets[w.key] = new Set();
    imports[w.key] = 0;
    exports[w.key] = 0;
  }

  const byFormat: Record<string, number> = {};
  let reports = 0;
  let rateLimited = 0;
  let rejected = 0;
  // 30-day per-day series for the sparkline.
  const perDay: Record<string, { imports: number; visitors: Set<string> }> = {};
  const today = new Date().toISOString().slice(0, 10);

  for (const file of files) {
    const date = file.replace(/\.jsonl$/, "");
    let text = "";
    try {
      text = await readFile(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: { ts?: string; event?: string; ip_hash?: string; format?: string };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = rec.ts ? Date.parse(rec.ts) : NaN;
      const age = Number.isFinite(ts) ? now - ts : Infinity;

      // Which windows does this event fall inside?
      const inWindow = (w: { ms: number | null }) => w.ms === null || age <= w.ms;

      if (rec.event === "visit") {
        if (rec.ip_hash) {
          for (const w of WINDOWS) if (inWindow(w)) visitorSets[w.key].add(rec.ip_hash);
          const day = (perDay[date] ??= { imports: 0, visitors: new Set() });
          day.visitors.add(rec.ip_hash);
        }
      } else if (rec.event === "import") {
        for (const w of WINDOWS) if (inWindow(w)) imports[w.key]++;
        (perDay[date] ??= { imports: 0, visitors: new Set() }).imports++;
      } else if (rec.event === "export") {
        for (const w of WINDOWS) if (inWindow(w)) exports[w.key]++;
        if (rec.format) byFormat[rec.format] = (byFormat[rec.format] ?? 0) + 1;
      } else if (rec.event === "report") {
        reports++;
      } else if (rec.event === "rate-limited") {
        rateLimited++;
      } else if (rec.event === "rejected") {
        rejected++;
      }
    }
  }

  const windows: Record<string, WindowCounts> = {};
  for (const w of WINDOWS) {
    windows[w.key] = {
      visitors: visitorSets[w.key].size,
      imports: imports[w.key],
      exports: exports[w.key],
    };
  }

  const series = Object.keys(perDay)
    .sort()
    .slice(-30)
    .map((d) => ({ date: d, imports: perDay[d].imports, visitors: perDay[d].visitors.size }));

  const data = {
    windows,
    exports_by_format: byFormat,
    reports_total: reports,
    rate_limited_total: rateLimited,
    rejected_total: rejected,
    series,
    today,
    generated_at: new Date().toISOString(),
  };
  cache = { at: now, data };
  return NextResponse.json(data);
}
