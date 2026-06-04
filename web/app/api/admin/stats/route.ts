/**
 * GET /api/admin/stats — admin-gated, full analytics.
 *
 * Reads the entire audit log (not just the last 7 days like the
 * public /api/stats) and returns all-time + per-day breakdowns:
 *   - unique visitors (all-time, today)
 *   - documents imported / exported / by format
 *   - per-day series for the last 30 days (for a sparkline)
 *   - rate-limit + rejection counts (operational signal)
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { adminConfigured, isAdminRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const dir = auditDir();
  const today = new Date().toISOString().slice(0, 10);

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    /* no audit dir yet */
  }

  const allVisitors = new Set<string>();
  const todayVisitors = new Set<string>();
  let imports = 0;
  let exports = 0;
  let reports = 0;
  let rateLimited = 0;
  let rejected = 0;
  const byFormat: Record<string, number> = {};
  // Per-day series (last 30 days) of imports + visitors.
  const perDay: Record<string, { imports: number; visitors: Set<string> }> = {};

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
      let rec: { event?: string; ip_hash?: string; format?: string };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const day = (perDay[date] ??= { imports: 0, visitors: new Set() });
      switch (rec.event) {
        case "visit":
          if (rec.ip_hash) {
            allVisitors.add(rec.ip_hash);
            day.visitors.add(rec.ip_hash);
            if (date === today) todayVisitors.add(rec.ip_hash);
          }
          break;
        case "import":
          imports++;
          day.imports++;
          break;
        case "export":
          exports++;
          if (rec.format) byFormat[rec.format] = (byFormat[rec.format] ?? 0) + 1;
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

  const series = Object.keys(perDay)
    .sort()
    .slice(-30)
    .map((d) => ({
      date: d,
      imports: perDay[d].imports,
      visitors: perDay[d].visitors.size,
    }));

  return NextResponse.json({
    visitors_all_time: allVisitors.size,
    visitors_today: todayVisitors.size,
    imports_total: imports,
    exports_total: exports,
    reports_total: reports,
    rate_limited_total: rateLimited,
    rejected_total: rejected,
    exports_by_format: byFormat,
    series,
    generated_at: new Date().toISOString(),
  });
}
