/**
 * GET /api/admin/stats — admin-gated, comprehensive analytics.
 *
 * One pass over the whole audit log produces:
 *   - windows: rolling-window counts (hour/day/week/month/year/all)
 *     of unique visitors, imports, exports
 *   - funnel: landing visitors → editor visitors → imports + the
 *     conversion %
 *   - formats: imports-by-format and exports-by-format
 *   - performance: average import + export processing time (ms)
 *   - totals: bytes processed, bug reports, rate-limited hits,
 *     rejections, error rate
 *   - series: 30-day per-day imports / exports / visitors
 *
 * 30s in-memory cache so dashboard refreshes don't re-scan the log.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { adminConfigured, isAdminRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 30 * 1000;

const WINDOWS: { key: string; ms: number | null }[] = [
  { key: "hour", ms: 60 * 60 * 1000 },
  { key: "day", ms: 24 * 60 * 60 * 1000 },
  { key: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { key: "all", ms: null },
];

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
    /* none yet */
  }

  // Per-window accumulators.
  const wVisitors: Record<string, Set<string>> = {};
  const wImports: Record<string, number> = {};
  const wExports: Record<string, number> = {};
  for (const w of WINDOWS) {
    wVisitors[w.key] = new Set();
    wImports[w.key] = 0;
    wExports[w.key] = 0;
  }

  const importsByFormat: Record<string, number> = {};
  const exportsByFormat: Record<string, number> = {};
  const landingVisitors = new Set<string>();
  const editorVisitors = new Set<string>();
  let importMsSum = 0;
  let importMsCount = 0;
  let exportMsSum = 0;
  let exportMsCount = 0;
  let bytesProcessed = 0;
  let importsAll = 0;
  let reports = 0;
  let rateLimited = 0;
  let rejected = 0;

  const perDay: Record<
    string,
    { imports: number; exports: number; visitors: Set<string> }
  > = {};
  const dayOf = (rec: { ts?: string }) => (rec.ts ? rec.ts.slice(0, 10) : "?");

  for (const file of files) {
    let text = "";
    try {
      text = await readFile(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: {
        ts?: string;
        event?: string;
        route?: string;
        ip_hash?: string;
        format?: string;
        bytes?: number;
        ms?: number;
      };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = rec.ts ? Date.parse(rec.ts) : NaN;
      const age = Number.isFinite(ts) ? now - ts : Infinity;
      const inW = (w: { ms: number | null }) => w.ms === null || age <= w.ms;
      const date = dayOf(rec);
      const bucket = (perDay[date] ??= { imports: 0, exports: 0, visitors: new Set() });

      switch (rec.event) {
        case "visit":
          if (rec.ip_hash) {
            for (const w of WINDOWS) if (inW(w)) wVisitors[w.key].add(rec.ip_hash);
            bucket.visitors.add(rec.ip_hash);
            if (rec.route === "/landing") landingVisitors.add(rec.ip_hash);
            else if (rec.route === "/editor") editorVisitors.add(rec.ip_hash);
          }
          break;
        case "import":
          importsAll++;
          for (const w of WINDOWS) if (inW(w)) wImports[w.key]++;
          bucket.imports++;
          if (rec.format) importsByFormat[rec.format] = (importsByFormat[rec.format] ?? 0) + 1;
          if (typeof rec.bytes === "number") bytesProcessed += rec.bytes;
          if (typeof rec.ms === "number") {
            importMsSum += rec.ms;
            importMsCount++;
          }
          break;
        case "export":
          for (const w of WINDOWS) if (inW(w)) wExports[w.key]++;
          bucket.exports++;
          if (rec.format) exportsByFormat[rec.format] = (exportsByFormat[rec.format] ?? 0) + 1;
          if (typeof rec.ms === "number") {
            exportMsSum += rec.ms;
            exportMsCount++;
          }
          break;
        case "report":
          reports++;
          break;
        case "rate-limited":
          rateLimited++;
          break;
        case "rejected":
          rejected++;
          break;
      }
    }
  }

  const windows: Record<string, { visitors: number; imports: number; exports: number }> = {};
  for (const w of WINDOWS) {
    windows[w.key] = {
      visitors: wVisitors[w.key].size,
      imports: wImports[w.key],
      exports: wExports[w.key],
    };
  }

  const series = Object.keys(perDay)
    .sort()
    .slice(-30)
    .map((d) => ({
      date: d,
      imports: perDay[d].imports,
      exports: perDay[d].exports,
      visitors: perDay[d].visitors.size,
    }));

  const totalOps = importsAll + rejected;
  const data = {
    windows,
    funnel: {
      landing_visitors: landingVisitors.size,
      editor_visitors: editorVisitors.size,
      imports: importsAll,
      // % of landing visitors who ended up importing a document.
      conversion_pct:
        landingVisitors.size > 0
          ? Math.round((importsAll / landingVisitors.size) * 1000) / 10
          : 0,
    },
    formats: { imports: importsByFormat, exports: exportsByFormat },
    performance: {
      avg_import_ms: importMsCount ? Math.round(importMsSum / importMsCount) : 0,
      avg_export_ms: exportMsCount ? Math.round(exportMsSum / exportMsCount) : 0,
    },
    totals: {
      bytes_processed: bytesProcessed,
      reports,
      rate_limited: rateLimited,
      rejected,
      error_rate_pct: totalOps > 0 ? Math.round((rejected / totalOps) * 1000) / 10 : 0,
    },
    series,
    generated_at: new Date().toISOString(),
  };
  cache = { at: now, data };
  return NextResponse.json(data);
}
