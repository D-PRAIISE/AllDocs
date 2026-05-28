/**
 * Append-only audit log.
 *
 * Records each user action (import / export / report) with
 * event metadata: timestamp, route, format, byte size, ms taken,
 * and an IP HASH (not the raw IP — we don't want to retain user
 * identifiers any longer than necessary).
 *
 * Lives at <repoRoot>/audit/<YYYY-MM-DD>.jsonl as a JSONL file
 * (one event per line) so an operator can grep / tail / rotate
 * without specialised tooling. NOT in web/public — never served.
 *
 * Privacy: NO document content, NO filenames. Only event metadata.
 * This is the audit trail the privacy doc references (docs/PRIVACY.md):
 * proof that AllDocs only retained user files for the documented
 * windows.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export type AuditEvent =
  | "import"
  | "export"
  | "report"
  | "rate-limited"
  | "rejected";

export interface AuditRecord {
  ts: string;
  event: AuditEvent;
  route: string;
  ip_hash: string;
  format?: string;
  bytes?: number;
  ms?: number;
  status?: number;
  error?: string;
}

const IP_HASH_SALT = process.env.ALLDOCS_IP_HASH_SALT || "alldocs-default-salt";

function auditDir(): string {
  return resolve(process.cwd(), "..", "audit");
}

export function hashIp(ip: string): string {
  return createHash("sha256")
    .update(IP_HASH_SALT + ":" + ip)
    .digest("hex")
    .slice(0, 16);
}

export async function recordEvent(rec: Omit<AuditRecord, "ts">): Promise<void> {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, ...rec }) + "\n";
  const dir = auditDir();
  const date = ts.slice(0, 10);
  const path = join(dir, `${date}.jsonl`);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(path, line, "utf-8");
  } catch {
    // Best-effort. We don't want a write failure on the audit log
    // to block the request — the user's action should still complete.
  }
}
