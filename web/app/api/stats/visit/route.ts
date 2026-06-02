/**
 * POST /api/stats/visit
 *
 * Fired once per browser session by <PageViewBeacon/>. Records a
 * `visit` event in the audit log with the hashed IP + which page.
 * No cookies, no localStorage UUID, no fingerprint — uniqueness is
 * approximated by hashed IP within a time window when aggregating.
 *
 * Body: { page?: string }  (e.g. "landing" | "editor")
 *
 * Privacy: identical posture to the rest of the audit log. The IP is
 * salted SHA-256, 16-char prefix; nothing else identifying. Already
 * disclosed in docs/PRIVACY.md.
 */
import { NextResponse, type NextRequest } from "next/server";

import { applyApiGuards } from "@/lib/api-guards";
import { hashIp, recordEvent } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PAGES = new Set(["landing", "editor"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate-limited like every other route so a loop can't flood the log.
  const guard = await applyApiGuards(req, "/api/stats/visit");
  if (!guard.allowed) return guard.response;

  let page = "unknown";
  try {
    const body = (await req.json()) as { page?: unknown };
    if (typeof body?.page === "string" && ALLOWED_PAGES.has(body.page)) {
      page = body.page;
    }
  } catch {
    // No body / bad JSON → record as unknown page. Still a valid visit.
  }

  await recordEvent({
    event: "visit",
    route: `/${page}`,
    ip_hash: hashIp(clientIp(req)),
    status: 200,
  });

  return NextResponse.json({ ok: true });
}
