/**
 * POST /api/telemetry
 *
 * Body: { event: string, props?: Record<string, string | number | boolean> }
 *
 * Receives opt-in anonymous events from the client and appends them
 * to telemetry/<YYYY-MM-DD>.jsonl. Same privacy posture as the
 * audit log:
 *   - IP is salted SHA-256 hashed; only a 16-char prefix is stored
 *   - No document content, no filenames, no full error message bodies
 *   - Props are validated to be primitive strings / numbers / booleans
 *     so a misbehaving caller can't sneak in objects with PII
 *
 * Off by default on the client. The user has to flip the toggle in
 * the privacy modal for the client to call this endpoint at all.
 *
 * Sized for hosted-only AllDocs; a horizontal-scale deployment
 * would replace the file with a Redis stream or a managed sink.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyApiGuards, logRejection, logSuccess } from "@/lib/api-guards";
import { hashIp } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 10;
export const dynamic = "force-dynamic";

const MAX_POST_BYTES = 8 * 1024; // events are tiny by spec
const MAX_PROP_KEYS = 12;
const MAX_PROP_VALUE_LEN = 200;
const ALLOWED_EVENT = /^[a-z0-9_.-]{1,64}$/;

function telemetryDir(): string {
  return resolve(process.cwd(), "..", "telemetry");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await applyApiGuards(req, "/api/telemetry");
  if (!guard.allowed) return guard.response;

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    logRejection("/api/telemetry", guard.ipHash, 400, "could not read body");
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (raw.length > MAX_POST_BYTES) {
    logRejection("/api/telemetry", guard.ipHash, 413, "payload too large");
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    logRejection("/api/telemetry", guard.ipHash, 400, "invalid JSON");
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const event = (body as { event?: unknown } | null)?.event;
  if (typeof event !== "string" || !ALLOWED_EVENT.test(event)) {
    logRejection("/api/telemetry", guard.ipHash, 400, "bad event name");
    return NextResponse.json(
      { error: "event must be a short lowercase identifier" },
      { status: 400 }
    );
  }
  const propsIn = (body as { props?: Record<string, unknown> } | null)?.props ?? {};

  // Sanitise props: keep only short primitive values. Objects / arrays
  // / nested anything are dropped to prevent a misbehaving caller from
  // smuggling document content into telemetry.
  const props: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(propsIn)) {
    if (n >= MAX_PROP_KEYS) break;
    if (typeof k !== "string" || k.length > 64) continue;
    if (typeof v === "string") {
      props[k] = v.slice(0, MAX_PROP_VALUE_LEN);
      n++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      props[k] = v;
      n++;
    } else if (typeof v === "boolean") {
      props[k] = v;
      n++;
    }
  }

  const ts = new Date().toISOString();
  const record = {
    ts,
    event,
    ip_hash: hashIp(clientIp(req)),
    props,
  };
  const date = ts.slice(0, 10);
  const path = join(telemetryDir(), `${date}.jsonl`);
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logRejection("/api/telemetry", guard.ipHash, 500, msg);
    return NextResponse.json({ error: "could not record" }, { status: 500 });
  }

  logSuccess("/api/telemetry", guard.ipHash, {
    event: "report",
    bytes: raw.length,
  });
  return NextResponse.json({ ok: true });
}
