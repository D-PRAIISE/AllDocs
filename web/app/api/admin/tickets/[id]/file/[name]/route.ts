/**
 * GET /api/admin/tickets/<id>/file/<name> — admin-gated download of a
 * single bug-report attachment (the user's PDF, the UDM, etc.).
 *
 * Hard path-traversal guard: both <id> and <name> are validated as
 * plain filenames and the resolved path must stay inside the specific
 * ticket directory.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";

import { adminConfigured, isAdminRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ticketsDir(): string {
  return resolve(process.cwd(), "..", "tickets");
}

const SAFE = /^[A-Za-z0-9._-]+$/;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; name: string }> }
): Promise<NextResponse> {
  if (!adminConfigured()) {
    return NextResponse.json({ error: "admin not configured" }, { status: 503 });
  }
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, name } = await ctx.params;
  // Validate both segments are plain names (no slashes, no "..").
  if (!SAFE.test(id) || !SAFE.test(name) || id !== basename(id) || name !== basename(name)) {
    return NextResponse.json({ error: "bad path" }, { status: 400 });
  }

  const base = ticketsDir();
  const ticketDir = resolve(base, id);
  const filePath = resolve(ticketDir, name);
  // Belt-and-braces: resolved path must be inside this ticket dir.
  const sep = process.platform === "win32" ? "\\" : "/";
  if (filePath !== ticketDir && !filePath.startsWith(ticketDir + sep)) {
    return NextResponse.json({ error: "path traversal blocked" }, { status: 400 });
  }

  try {
    await stat(filePath);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const bytes = await readFile(filePath);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
    },
  });
}
