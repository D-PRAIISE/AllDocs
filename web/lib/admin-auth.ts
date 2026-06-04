/**
 * Single-admin authentication for the /admin dashboard.
 *
 * There are no user accounts in AllDocs (privacy promise) — this is
 * the ONE operator login. Secured by an env var:
 *
 *     ALLDOCS_ADMIN_PASSWORD=<a long random string>
 *
 * Set it in the systemd unit. If it's unset, admin is DISABLED
 * entirely (fail closed) — every admin route returns 503.
 *
 * Flow: POST the password to /api/admin/login → if it matches, we set
 * an httpOnly, Secure, SameSite=Strict cookie containing a signed
 * token (HMAC-SHA256 over an expiry, keyed by a hash of the password).
 * Admin routes verify that cookie. No server-side session store; the
 * signature + expiry are self-contained.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "alldocs_admin";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function adminPassword(): string | null {
  const pw = process.env.ALLDOCS_ADMIN_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

/** True if an admin password is configured. When false, the whole
 * admin surface is disabled. */
export function adminConfigured(): boolean {
  return adminPassword() !== null;
}

/** Signing key = SHA-256 of the admin password. Keeps config to one
 * env var while not using the raw password as the HMAC key verbatim. */
function signingKey(pw: string): Buffer {
  return createHash("sha256").update("alldocs-admin:" + pw).digest();
}

/** Timing-safe password check. */
export function passwordMatches(input: string): boolean {
  const pw = adminPassword();
  if (pw === null) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(pw).digest();
  return timingSafeEqual(a, b);
}

/** Mint a signed session token: "<expiryMs>.<hexsig>". */
export function issueToken(): string {
  const pw = adminPassword();
  if (pw === null) throw new Error("admin not configured");
  const expiry = String(Date.now() + SESSION_MS);
  const sig = createHmac("sha256", signingKey(pw)).update(expiry).digest("hex");
  return `${expiry}.${sig}`;
}

/** Verify a session token: signature valid + not expired. */
export function verifyToken(token: string | undefined): boolean {
  const pw = adminPassword();
  if (pw === null || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const expiry = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", signingKey(pw)).update(expiry).digest("hex");
  // Constant-time compare of the hex signatures.
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) return false;
  if (!timingSafeEqual(sigBuf, expBuf)) return false;
  const expiryMs = Number(expiry);
  return Number.isFinite(expiryMs) && Date.now() < expiryMs;
}

/** Read the admin cookie off a request and verify it. */
export function isAdminRequest(req: { cookies: { get(name: string): { value: string } | undefined } }): boolean {
  return verifyToken(req.cookies.get(ADMIN_COOKIE)?.value);
}

export const SESSION_MAX_AGE_SEC = Math.floor(SESSION_MS / 1000);
