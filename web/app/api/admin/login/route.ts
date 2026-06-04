/**
 * POST /api/admin/login   body: { password }
 *   → sets the signed admin cookie on success.
 * DELETE /api/admin/login  → clears the cookie (logout).
 */
import { NextResponse, type NextRequest } from "next/server";

import { applyApiGuards, logRejection } from "@/lib/api-guards";
import {
  ADMIN_COOKIE,
  SESSION_MAX_AGE_SEC,
  adminConfigured,
  issueToken,
  passwordMatches,
} from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate-limit login attempts hard against brute force (shares the
  // per-IP bucket; the per-minute cap throttles guessing).
  const guard = await applyApiGuards(req, "/api/admin/login");
  if (!guard.allowed) return guard.response;

  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "admin is not configured on this instance" },
      { status: 503 }
    );
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body?.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!passwordMatches(password)) {
    logRejection("/api/admin/login", guard.ipHash, 401, "bad admin password");
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, issueToken(), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return res;
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
