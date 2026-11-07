/**
 * Shared per-request guards for API routes:
 *   - rate limiting (in-memory token bucket per IP)
 *   - audit-event side effects (no document content, hashed IP only)
 *
 * Used by every /api/* route so the cross-cutting concerns live in
 * one place instead of being copy-pasted at the top of nine route
 * handlers.
 */
import { NextResponse } from "next/server";

import { hashIp, recordEvent } from "./audit";
import { checkRateLimit, clientIp } from "./rate-limit";

export interface GuardOk {
  allowed: true;
  ip: string;
  ipHash: string;
}
export interface GuardBlocked {
  allowed: false;
  response: NextResponse;
}
export type GuardResult = GuardOk | GuardBlocked;

/** Per-request enforcement: rate-limit + IP hashing. Call at the
 * top of each API route; pass the route key. When `allowed=false`,
 * return the embedded response immediately. */
export async function applyApiGuards(
  req: { headers: Headers },
  route: string
): Promise<GuardResult> {
  const ip = clientIp(req);
  const decision = checkRateLimit(ip, route);
  const ipHash = hashIp(ip);
  if (!decision.allowed) {
    await recordEvent({
      event: "rate-limited",
      route,
      ip_hash: ipHash,
      status: 429,
    });
    return {
      allowed: false,
      response: NextResponse.json(
        { error: `rate limit — retry in ${decision.retryAfterSec}s` },
        {
          status: 429,
          headers: { "Retry-After": String(decision.retryAfterSec) },
        }
      ),
    };
  }
  return { allowed: true, ip, ipHash };
}

/** Wrap the success-path recordEvent call so each route stays one
 * line. Errors swallowed (best-effort audit). */
export function logSuccess(
  route: string,
  ipHash: string,
  details: {
    format?: string;
    bytes?: number;
    ms?: number;
    event?: "import" | "export" | "report";
  }
): void {
  void recordEvent({
    event: details.event ?? "export",
    route,
    ip_hash: ipHash,
    format: details.format,
    bytes: details.bytes,
    ms: details.ms,
    status: 200,
  });
}

/** How much of a failed subprocess's output to keep in the audit log. */
const ERROR_LOG_MAX = 900;

/**
 * Keep the part of an error that identifies it.
 *
 * These are mostly Python tracebacks from the adapters, and a traceback
 * is written worst-first: the top is runpy boilerplate identical in
 * every failure, and the exception type and message are on the LAST
 * line. This used to keep `error.slice(0, 200)`, so eighteen export
 * failures over seven weeks each recorded the same four lines of
 * "/usr/lib/python3.10/runpy.py" and discarded every actual cause. The
 * bug behind them could not be diagnosed from the log at all; it took
 * reproducing it on the box by hand.
 *
 * So keep the head for context and the tail for the cause.
 */
function diagnosable(error: string): string {
  const flat = error.trim();
  if (flat.length <= ERROR_LOG_MAX) return flat;
  const head = flat.slice(0, 160);
  const tail = flat.slice(flat.length - (ERROR_LOG_MAX - head.length - 5));
  return `${head}
 […] 
${tail}`;
}

export function logRejection(
  route: string,
  ipHash: string,
  status: number,
  error?: string
): void {
  void recordEvent({
    event: "rejected",
    route,
    ip_hash: ipHash,
    status,
    error: error === undefined ? undefined : diagnosable(error),
  });
}
