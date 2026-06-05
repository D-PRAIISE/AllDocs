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
  | "running"
  | "done"
  | "error"
  | "password_required"
  | "password_wrong";

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
  createdAt: number;
  startedAt: number;
  result?: ImportJobResult;
  error?: string;
}

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
}): ImportJob {
  prune();
  const now = Date.now();
  const job: ImportJob = {
    id: init.id,
    status: "running",
    filename: init.filename,
    format: init.format,
    size: init.size,
    createdAt: now,
    startedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getImportJob(id: string): ImportJob | undefined {
  return jobs.get(id);
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
