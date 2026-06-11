/**
 * GET /api/import/status/[jobId]
 *
 * Long-polled by the client after POST /api/import returns a job_id.
 * Rather than make the client fire a request every second (each
 * carrying framework overhead and stealing CPU from the OCR
 * subprocess), this endpoint *holds* the connection and resolves the
 * moment the job finishes — or after MAX_HOLD_MS, so the client can
 * re-ask. The hold cap stays well under Cloudflare's ~100s origin
 * timeout. Not rate-limited: it only reads an in-memory map.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getImportJob } from "@/lib/import-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long a single request may wait for the job to finish before
// returning "still running" (kept under the Cloudflare 100s ceiling).
const MAX_HOLD_MS = 25_000;
// Cheap map re-check cadence while holding. await yields the event
// loop between checks, so this doesn't block other requests or the
// importer.
const CHECK_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await ctx.params;

  let job = getImportJob(jobId);
  if (!job) {
    // Either never existed or aged out of the registry.
    return NextResponse.json(
      { status: "unknown", error: "unknown or expired job" },
      { status: 404 }
    );
  }

  // Hold until the job reaches a terminal state (or we hit the cap).
  // "queued" (waiting for a CPU slot) and "running" are both non-terminal.
  const deadline = Date.now() + MAX_HOLD_MS;
  while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) {
    await sleep(CHECK_MS);
    job = getImportJob(jobId) ?? job;
  }

  const elapsed_ms = Date.now() - job.startedAt;

  if (job.status === "done" && job.result) {
    return NextResponse.json({ status: "done", elapsed_ms, ...job.result });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", elapsed_ms, error: job.error });
  }
  if (job.status === "password_required" || job.status === "password_wrong") {
    return NextResponse.json({ status: job.status, elapsed_ms });
  }
  // Still queued (waiting for a CPU slot) or running — report which so
  // the client can say "waiting in queue" vs. show pipeline stages.
  return NextResponse.json({
    status: job.status, // "queued" | "running"
    elapsed_ms,
    filename: job.filename,
    format: job.format,
  });
}
