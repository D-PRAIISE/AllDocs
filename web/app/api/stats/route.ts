/**
 * GET /api/stats
 *
 * Aggregates the audit log into public-safe counters:
 *   - unique visitors today / this week (distinct hashed IPs on
 *     `visit` events)
 *   - documents processed today / total (import events)
 *   - documents edited (export events)
 *   - PDFs edited (export events with format=pdf)
 *
 * Reads only the last N daily JSONL files (default 7) so the scan
 * stays bounded. Cached for a minute to avoid re-reading on every
 * landing-page hit.
 *
 * Everything here is derived from data we already keep (the audit
 * log) — no new tracking, no document content. Hashed IPs are only
 * compared for distinctness, never displayed or stored further.
 */
import { NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;
const CACHE_TTL_MS = 60 * 1000;

interface StatsPayload {
  visitors_today: number;
  visitors_week: number;
  docs_today: number;
  docs_total_window: number;
  docs_edited_window: number;
  pdfs_edited_window: number;
  generated_at: string;
}

let cache: { at: number; data: StatsPayload } | null = null;

function auditDir(): string {
  return resolve(process.cwd(), "..", "audit");
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const dir = auditDir();
  const today = new Date().toISOString().slice(0, 10);

  let files: string[] = [];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-WINDOW_DAYS);
  } catch {
    // No audit dir yet — return zeros rather than erroring.
  }

  const visitorsToday = new Set<string>();
  const visitorsWeek = new Set<string>();
  let docsToday = 0;
  let docsTotalWindow = 0;
  let docsEditedWindow = 0;
  let pdfsEditedWindow = 0;

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
      let rec: {
        event?: string;
        ip_hash?: string;
        format?: string;
      };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = rec.event;
      if (ev === "visit") {
        if (rec.ip_hash) {
          visitorsWeek.add(rec.ip_hash);
          if (date === today) visitorsToday.add(rec.ip_hash);
        }
      } else if (ev === "import") {
        docsTotalWindow++;
        if (date === today) docsToday++;
      } else if (ev === "export") {
        docsEditedWindow++;
        if (rec.format === "pdf") pdfsEditedWindow++;
      }
    }
  }

  const data: StatsPayload = {
    visitors_today: visitorsToday.size,
    visitors_week: visitorsWeek.size,
    docs_today: docsToday,
    docs_total_window: docsTotalWindow,
    docs_edited_window: docsEditedWindow,
    pdfs_edited_window: pdfsEditedWindow,
    generated_at: new Date().toISOString(),
  };
  cache = { at: now, data };
  return NextResponse.json(data);
}
