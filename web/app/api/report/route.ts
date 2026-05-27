/**
 * POST /api/report
 *
 * User-initiated bug report. Accepts a multipart/form-data submission
 * containing:
 *   description (text) — user's description of the problem
 *   source       (file, optional) — original source PDF/DOCX
 *   udm          (text, optional) — current UDM JSON state
 *   session_id   (text, optional) — links to /api/import session
 *   user_agent   (text, optional)
 *
 * Stores the report under <repoRoot>/tickets/<id>/ which is NOT in
 * web/public — these attachments are user-private and must never be
 * served back over the web. Returns the ticket ID so the user can
 * reference it if they email us.
 *
 * Privacy: this endpoint is the ONLY way user document data is
 * retained at all. Every submission is a deliberate user action,
 * never a background collection. See project_alldocs_data_policy.md.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Total attachment size cap — keeps an upset user with a 200MB scan
// from clogging the queue.
const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;

interface ReportResponse {
  ticket_id: string;
  received_at: string;
}

interface ErrorResponse {
  error: string;
}

function ticketsRoot(): string {
  // tickets/ lives at the repo root, alongside web/, NOT inside
  // web/public/. Reports are never served back; this is private
  // storage that an operator reads off-cluster.
  return resolve(process.cwd(), "..", "tickets");
}

export async function POST(
  req: NextRequest
): Promise<NextResponse<ReportResponse | ErrorResponse>> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const description = String(formData.get("description") ?? "").trim();
  if (!description) {
    return NextResponse.json(
      { error: "description is required — tell us what went wrong" },
      { status: 400 }
    );
  }
  if (description.length > 8000) {
    return NextResponse.json(
      { error: "description too long (max 8000 chars)" },
      { status: 400 }
    );
  }

  const source = formData.get("source");
  const udm = formData.get("udm");
  const sessionId = String(formData.get("session_id") ?? "").trim();
  const userAgent = String(formData.get("user_agent") ?? "").trim();

  // Size cap across all attachments.
  let total = description.length;
  if (typeof udm === "string") total += udm.length;
  if (source instanceof File) total += source.size;
  if (total > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: "attachments exceed size limit" },
      { status: 413 }
    );
  }

  const ticketId = randomUUID();
  const receivedAt = new Date().toISOString();
  const ticketDir = join(ticketsRoot(), ticketId);

  try {
    await mkdir(ticketDir, { recursive: true });

    // Description + metadata as plain text so an operator can grep.
    const metadata = {
      ticket_id: ticketId,
      received_at: receivedAt,
      session_id: sessionId || null,
      user_agent: userAgent || null,
      source_filename: source instanceof File ? source.name : null,
      source_size: source instanceof File ? source.size : null,
      has_udm: typeof udm === "string" && udm.length > 0,
    };
    await writeFile(join(ticketDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
    await writeFile(join(ticketDir, "description.txt"), description, "utf-8");
    if (typeof udm === "string" && udm.length > 0) {
      await writeFile(join(ticketDir, "current.udm.json"), udm, "utf-8");
    }
    if (source instanceof File) {
      const buf = Buffer.from(await source.arrayBuffer());
      const ext = source.name.split(".").pop()?.toLowerCase() || "bin";
      await writeFile(join(ticketDir, `source.${ext}`), buf);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `failed to save report: ${msg}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ticket_id: ticketId,
    received_at: receivedAt,
  });
}
