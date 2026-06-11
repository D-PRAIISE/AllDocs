/**
 * In-process registry of running/finished import jobs.
 *
 * Import work (especially OCR on scanned PDFs) can take minutes — far
 * past Cloudflare's ~100s origin-response timeout. So /api/import no
 * longer blocks on the importer: it enqueues a job, returns a job_id,
 * and the client polls /api/import/status/[jobId]. This module is the
 * shared state between those two routes.
 *
 * Storage is a plain Map kept on globalThis. AllDocs runs as a single
 * long-lived Node process (systemd `next start`), so in-memory is fine
 * and survives module duplication / dev HMR via the global handle. If
 * this ever scales to multiple processes, swap the Map for Redis.
 */

export type ImportJobStatus =
  | "queued" // accepted, waiting for a CPU slot (heavy OCR formats only)
  | "running"
  | "done"
  | "error"
  | "password_required"
  | "password_wrong";

// Resource guards for a small shared VPS. Heavy (OCR-capable) imports
// are gated through a semaphore so a burst can't pin every core for
// minutes; light formats (md/html/office) skip the gate and stay snappy.
// All overridable via env for bigger hosts.
export const MAX_CONCURRENT_HEAVY = Math.max(
  1,
  Number(process.env.ALLDOCS_MAX_CONCURRENT_IMPORTS ?? 2),
);
export const MAX_ACTIVE_PER_IP = Math.max(
  1,
  Number(process.env.ALLDOCS_MAX_IMPORTS_PER_IP ?? 3),
);
export const MAX_ACTIVE_GLOBAL = Math.max(
  MAX_CONCURRENT_HEAVY,
  Number(process.env.ALLDOCS_MAX_ACTIVE_IMPORTS ?? 50),
);

/** Heavy = CPU-bound OCR path (scanned PDFs + images). These are gated. */
export function isHeavyFormat(format: string): boolean {
  return format === "pdf" || format === "image";
}

export interface ImportJobResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: string;
  ms_taken: number;
  had_password: boolean;
}

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  filename: string;
  format: string;
  size: number;
  ipHash: string;
  createdAt: number;
  startedAt: number;
  result?: ImportJobResult;
  error?: string;
}

const isActive = (s: ImportJobStatus) => s === "queued" || s === "running";

// Drop finished/abandoned jobs after this long so the map can't grow
// without bound. Generous enough to outlast any realistic import.
const JOB_TTL_MS = 15 * 60_000;

const g = globalThis as unknown as { __alldocsImportJobs?: Map<string, ImportJob> };
const jobs: Map<string, ImportJob> = g.__alldocsImportJobs ?? (g.__alldocsImportJobs = new Map());

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function createImportJob(init: {
  id: string;
  filename: string;
  format: string;
  size: number;
  ipHash: string;
}): ImportJob {
  prune();
  const now = Date.now();
  const job: ImportJob = {
    id: init.id,
    status: "queued",
    filename: init.filename,
    format: init.format,
    size: init.size,
    ipHash: init.ipHash,
    createdAt: now,
    startedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getImportJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

export function markImportJobRunning(id: string) {
  const job = jobs.get(id);
  if (job && job.status === "queued") job.status = "running";
}

/** Count of in-flight (queued or running) jobs, total and per-IP — used
 *  to reject floods before we spend work parsing the upload. */
export function activeJobCount(): number {
  let n = 0;
  for (const job of jobs.values()) if (isActive(job.status)) n++;
  return n;
}
export function activeJobCountForIp(ipHash: string): number {
  let n = 0;
  for (const job of jobs.values()) if (job.ipHash === ipHash && isActive(job.status)) n++;
  return n;
}

export function completeImportJob(id: string, result: ImportJobResult) {
  const job = jobs.get(id);
  if (job) {
    job.status = "done";
    job.result = result;
  }
}

export function failImportJob(
  id: string,
  status: Extract<ImportJobStatus, "error" | "password_required" | "password_wrong">,
  error?: string,
) {
  const job = jobs.get(id);
  if (job) {
    job.status = status;
    if (error) job.error = error;
  }
}

// ---- Heavy-import concurrency semaphore -------------------------------
// Caps how many CPU-bound OCR imports run at once so a burst can't pin
// every core for minutes. Excess imports wait (job stays "queued") until
// a slot frees. Like the job map, the state lives on globalThis so the
// two import routes share one instance in the single Node process.
interface Semaphore {
  running: number;
  queue: (() => void)[];
}
const sg = globalThis as unknown as { __alldocsImportSem?: Semaphore };
const sem: Semaphore = sg.__alldocsImportSem ?? (sg.__alldocsImportSem = { running: 0, queue: [] });

/** Acquire a heavy-import slot, awaiting a free one if all are taken. */
export function acquireHeavySlot(): Promise<void> {
  return new Promise((resolve) => {
    if (sem.running < MAX_CONCURRENT_HEAVY) {
      sem.running++;
      resolve();
    } else {
      sem.queue.push(resolve);
    }
  });
}

/** Release a heavy-import slot and hand it to the next waiter, if any. */
export function releaseHeavySlot(): void {
  sem.running = Math.max(0, sem.running - 1);
  if (sem.queue.length > 0 && sem.running < MAX_CONCURRENT_HEAVY) {
    const next = sem.queue.shift()!;
    sem.running++;
    next();
  }
}
