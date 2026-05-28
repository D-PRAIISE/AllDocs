/**
 * GET /api/health
 *
 * Always-200 endpoint for uptime monitors + on-call dashboards.
 * Returns the UDM schema version, process uptime, current sweep
 * config, and current rate-limit caps. No personally-identifying
 * data; no document data.
 */
import { NextResponse } from "next/server";

import { RATE_LIMITS } from "@/lib/rate-limit";
import { TTL_CONFIG } from "@/lib/upload-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOOTED_AT = Date.now();
const UDM_VERSION = "0.1.0";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    udm_version: UDM_VERSION,
    uptime_sec: Math.floor((Date.now() - BOOTED_AT) / 1000),
    rate_limit: RATE_LIMITS,
    ttl: TTL_CONFIG,
    node: process.version,
  });
}
