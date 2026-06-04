/**
 * GET /api/admin/tickets — admin-gated list of bug-report tickets.
 *
 * Returns each ticket's metadata + description + which attachments
 * exist (NOT their bytes — those download via the [id]/file route).
 * Newest first.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { adminConfigured, isAdminRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ticketsDir(): string {
  return resolve(process.cwd(), "..", "tickets");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!adminConfigured()) {
    return NextResponse.json({ error: "admin not configured" }, { status: 503 });
  }
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dir = ticketsDir();
  let ids: string[] = [];
  try {
    ids = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return NextResponse.json({ tickets: [] });
  }

  const tickets = [];
  for (const id of ids) {
    const tdir = join(dir, id);
    let meta: Record<string, unknown> = {};
    let description = "";
    const attachments: { name: string; size: number }[] = [];
    try {
      meta = JSON.parse(await readFile(join(tdir, "metadata.json"), "utf-8"));
    } catch {
      /* tolerate a malformed/partial ticket */
    }
    try {
      description = await readFile(join(tdir, "description.txt"), "utf-8");
    } catch {
      /* no description */
    }
    try {
      for (const f of await readdir(tdir)) {
        if (f === "metadata.json" || f === "description.txt") continue;
        try {
          const st = await stat(join(tdir, f));
          attachments.push({ name: f, size: st.size });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* none */
    }
    tickets.push({
      id,
      received_at: meta.received_at ?? null,
      session_id: meta.session_id ?? null,
      user_agent: meta.user_agent ?? null,
      source_filename: meta.source_filename ?? null,
      description,
      attachments,
    });
  }

  // Newest first by received_at (ISO strings sort lexicographically).
  tickets.sort((a, b) =>
    String(b.received_at ?? "").localeCompare(String(a.received_at ?? ""))
  );

  return NextResponse.json({ tickets });
}
