/**
 * Per-IP, per-route rate limiter (in-memory).
 *
 * Token bucket with two windows: a tight per-minute cap to stop
 * accidental loops, and a looser per-hour cap to catch sustained
 * abuse. State lives in a Map keyed by (ip, route); evicted lazily
 * when buckets refill to capacity.
 *
 * Lives in-process. That's fine for v1 (one Next.js node) but won't
 * coordinate across replicas — swap to Redis if/when AllDocs scales
 * horizontally. The interface is shaped so the swap is local.
 *
 * Anti-abuse posture: AllDocs is free + no-signup, which is exactly
 * what a scraper / abuse loop targets. The defaults are tuned to
 * leave normal interactive usage untouched.
 */

interface Bucket {
  // Tokens remaining per window.
  minute: { tokens: number; resetAt: number };
  hour: { tokens: number; resetAt: number };
}

const PER_MIN = Number(process.env.ALLDOCS_RATE_LIMIT_PER_MIN ?? 30);
const PER_HOUR = Number(process.env.ALLDOCS_RATE_LIMIT_PER_HOUR ?? 300);
const MS_PER_MIN = 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_BUCKETS = 5000; // cap memory; rotated LRU-ish via eviction

const buckets = new Map<string, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  // Seconds the client should wait before retrying when blocked.
  retryAfterSec: number;
  remaining: number;
}

/** Consume one token from the (ip, route) bucket. Returns the
 * decision; callers respond with 429 when allowed=false. */
export function checkRateLimit(ip: string, route: string): RateLimitDecision {
  // Refresh bucket sizes from env on every call so deployments that
  // tweak the cap with a hot-reload pick it up.
  const now = Date.now();
  const key = `${route}::${ip}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = makeBucket(now);
    insertBucket(key, bucket);
  }
  refill(bucket, now);
  if (bucket.minute.tokens <= 0) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.minute.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  if (bucket.hour.tokens <= 0) {
    return {
      allowed: false,
      retryAfterSec: Math.max(60, Math.ceil((bucket.hour.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  bucket.minute.tokens -= 1;
  bucket.hour.tokens -= 1;
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.min(bucket.minute.tokens, bucket.hour.tokens),
  };
}

function makeBucket(now: number): Bucket {
  return {
    minute: { tokens: PER_MIN, resetAt: now + MS_PER_MIN },
    hour: { tokens: PER_HOUR, resetAt: now + MS_PER_HOUR },
  };
}

function refill(bucket: Bucket, now: number): void {
  if (now >= bucket.minute.resetAt) {
    bucket.minute.tokens = PER_MIN;
    bucket.minute.resetAt = now + MS_PER_MIN;
  }
  if (now >= bucket.hour.resetAt) {
    bucket.hour.tokens = PER_HOUR;
    bucket.hour.resetAt = now + MS_PER_HOUR;
  }
}

function insertBucket(key: string, bucket: Bucket): void {
  if (buckets.size >= MAX_BUCKETS) {
    // Simple eviction: drop one. Map preserves insertion order so
    // the first key is the oldest entry.
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  buckets.set(key, bucket);
}

/** Extract the client IP from a Next.js request. Honours common
 * proxy headers; falls back to "anon" when no header is present
 * (typical for local dev). */
export function clientIp(req: Request | { headers: Headers }): string {
  const h = req.headers;
  const candidates = [
    h.get("cf-connecting-ip"),
    h.get("x-real-ip"),
    h.get("x-forwarded-for")?.split(",")[0]?.trim(),
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return "anon";
}

export const RATE_LIMITS = {
  perMinute: PER_MIN,
  perHour: PER_HOUR,
};
