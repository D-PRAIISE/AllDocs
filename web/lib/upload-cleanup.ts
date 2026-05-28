/**
 * Ephemeral upload sweeper.
 *
 * AllDocs's privacy promise (docs/PRIVACY.md) says uploaded files
 * auto-delete after the editing session ends. We enforce that by
 * sweeping web/public/uploads/ on a schedule: any session directory
 * whose mtime is older than the TTL (default 24h) is removed.
 *
 * Mechanism: lazy invocation on each /api/import. A module-level
 * lastSweepAt timestamp prevents thrashing — at most one sweep per
 * SWEEP_INTERVAL_MS regardless of incoming request volume. This keeps
 * the Next.js process self-contained (no external cron needed) and
 * works on every hosting target (Vercel, Fly, a VPS).
 *
 * On a real production deployment with persistent storage, this
 * should be paired with a separate systemd timer / k8s CronJob so
 * idle servers still sweep — but that's a config concern, not a
 * code dependency.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const UPLOAD_TTL_HOURS = Number(process.env.ALLDOCS_UPLOAD_TTL_HOURS ?? 24);
const TICKET_TTL_DAYS = Number(process.env.ALLDOCS_TICKET_TTL_DAYS ?? 30);
const SWEEP_INTERVAL_MS = Number(process.env.ALLDOCS_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);

let lastSweepAt = 0;
let sweepInFlight: Promise<void> | null = null;

export interface SweepResult {
  uploadsDeleted: number;
  uploadsKept: number;
  ticketsDeleted: number;
  ticketsKept: number;
  durationMs: number;
}

/** Run a sweep at most once per SWEEP_INTERVAL_MS. Safe to call
 * from every request — concurrent callers share the same promise. */
export async function maybeSweep(
  uploadsDir: string,
  ticketsDir: string
): Promise<SweepResult | null> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return null;
  if (sweepInFlight) {
    await sweepInFlight;
    return null;
  }
  lastSweepAt = now;
  let resolve_: () => void = () => {};
  sweepInFlight = new Promise<void>((r) => {
    resolve_ = r;
  });
  try {
    return await sweepNow(uploadsDir, ticketsDir);
  } finally {
    resolve_();
    sweepInFlight = null;
  }
}

export async function sweepNow(
  uploadsDir: string,
  ticketsDir: string
): Promise<SweepResult> {
  const started = Date.now();
  const uploadCutoff = started - UPLOAD_TTL_HOURS * 60 * 60 * 1000;
  const ticketCutoff = started - TICKET_TTL_DAYS * 24 * 60 * 60 * 1000;

  const [uploads, tickets] = await Promise.all([
    sweepDirectory(uploadsDir, uploadCutoff),
    sweepDirectory(ticketsDir, ticketCutoff),
  ]);

  return {
    uploadsDeleted: uploads.deleted,
    uploadsKept: uploads.kept,
    ticketsDeleted: tickets.deleted,
    ticketsKept: tickets.kept,
    durationMs: Date.now() - started,
  };
}

async function sweepDirectory(
  root: string,
  cutoffMs: number
): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // Directory may not exist yet — that's fine, nothing to sweep.
    return { deleted: 0, kept: 0 };
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue; // .gitignore etc.
    const full = join(root, name);
    try {
      const st = await stat(full);
      const ts = Math.max(st.mtimeMs, st.ctimeMs);
      if (ts < cutoffMs) {
        await rm(full, { recursive: true, force: true });
        deleted++;
      } else {
        kept++;
      }
    } catch {
      // best-effort sweeper — individual failures don't abort
      continue;
    }
  }
  return { deleted, kept };
}

export const TTL_CONFIG = {
  uploadHours: UPLOAD_TTL_HOURS,
  ticketDays: TICKET_TTL_DAYS,
  sweepIntervalMs: SWEEP_INTERVAL_MS,
};
