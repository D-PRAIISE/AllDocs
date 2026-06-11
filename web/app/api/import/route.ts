/**
 * POST /api/import
 *
 * Accepts a multipart/form-data upload with a PDF or DOCX file in the
 * `file` field, dispatches to the matching Python adapter as a subprocess,
 * and returns a URL to the generated UDM JSON document.
 *
 * Files are stored under web/public/uploads/<session_id>/ so they're
 * directly servable by Next.js. This is fine for local development;
 * production deployment should swap this for ephemeral object storage
 * (MinIO) with a TTL — see project_alldocs.md anti-abuse plan.
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { hashIp, recordEvent } from "@/lib/audit";
import {
  acquireHeavySlot,
  activeJobCount,
  activeJobCountForIp,
  completeImportJob,
  createImportJob,
  failImportJob,
  isHeavyFormat,
  markImportJobRunning,
  releaseHeavySlot,
  MAX_ACTIVE_GLOBAL,
  MAX_ACTIVE_PER_IP,
} from "@/lib/import-jobs";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { maybeSweep } from "@/lib/upload-cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Upload cap, in bytes. Default 200 MB — generous vs. competitors
// (Smallpdf ~10MB free, ilovePDF 200MB throttled) while staying inside
// the subprocess memory envelope: PyMuPDF holds the whole PDF in
// memory while patching / rendering, and OCR on a multi-hundred-MB
// scan would blow the 180s subprocess timeout anyway.
//
// Operator override: set ALLDOCS_MAX_UPLOAD_MB to whatever cap your
// host can actually serve safely (RAM + bandwidth + timeout).
const MAX_FILE_BYTES =
  Number(process.env.ALLDOCS_MAX_UPLOAD_MB ?? 200) * 1024 * 1024;
// OCR of scanned pages runs at import time (~6-8 s/page via Tesseract),
// so the importer can legitimately take a while on multi-page scans.
// The import now runs as a background job (the client polls for
// completion), so we're no longer bound by the HTTP/Cloudflare ~100s
// response timeout — a large scan can take several minutes.
const SUBPROCESS_TIMEOUT_MS = 600_000;
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\3\4 (DOCX/ODT/XLSX/PPTX)
// Image magic bytes — used by detectFormat so a renamed file with the
// wrong extension still gets rejected.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38]);
const BMP_MAGIC = Buffer.from([0x42, 0x4d]);
// WebP: starts with "RIFF" then 4 bytes then "WEBP" at offset 8
// TIFF: starts with II*\0 (little-endian) or MM\0* (big-endian)
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff",
]);

type Format = "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx" | "image";

interface AdapterSpec {
  format: Format;
  module: string;
  pythonPathSubdir: string;
  // PDF supports asset extraction; DOCX/MD/HTML don't yet.
  extractsAssets: boolean;
}

const ADAPTERS: Record<Format, AdapterSpec> = {
  pdf: {
    format: "pdf",
    module: "pdf_adapter.cli",
    pythonPathSubdir: "pdf-adapter/src",
    extractsAssets: true,
  },
  docx: {
    format: "docx",
    module: "office_adapter.cli",
    pythonPathSubdir: "office-adapter/src",
    extractsAssets: false,
  },
  md: {
    format: "md",
    module: "text_adapter.cli",
    pythonPathSubdir: "text-adapter/src",
    extractsAssets: false,
  },
  html: {
    format: "html",
    module: "text_adapter.cli",
    pythonPathSubdir: "text-adapter/src",
    extractsAssets: false,
  },
  epub: {
    format: "epub",
    module: "text_adapter.cli",
    pythonPathSubdir: "text-adapter/src",
    extractsAssets: false,
  },
  xlsx: {
    format: "xlsx",
    module: "office_adapter.cli",
    pythonPathSubdir: "office-adapter/src",
    extractsAssets: false,
  },
  pptx: {
    format: "pptx",
    module: "office_adapter.cli",
    pythonPathSubdir: "office-adapter/src",
    extractsAssets: false,
  },
  // Raw image uploads (PNG/JPG/WEBP/GIF/BMP/TIFF) — wrapped as a
  // single-page fixed-mode UDM by the pdf-adapter's image_importer
  // (it sits next to the PDF importer because they share the OCR
  // pipeline and produce the same UDM mode).
  image: {
    format: "image",
    module: "pdf_adapter.cli",
    pythonPathSubdir: "pdf-adapter/src",
    extractsAssets: false,
  },
};

function paths() {
  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  return {
    webRoot,
    repoRoot,
    servicesRoot: resolve(repoRoot, "services"),
    publicUploads: resolve(webRoot, "public", "uploads"),
    ticketsRoot: resolve(repoRoot, "tickets"),
  };
}

function detectFormat(buf: Buffer, filename: string): Format | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) {
    return "pdf";
  }
  if (ext === "docx" && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    return "docx";
  }
  if (ext === "md" || ext === "markdown" || ext === "mdown") {
    return "md";
  }
  if (ext === "html" || ext === "htm" || ext === "xhtml") {
    return "html";
  }
  // EPUB is a zip but with a strict mimetype payload. The magic
  // header is still ZIP — we trust the extension here; the importer
  // validates internally.
  if (ext === "epub" && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    return "epub";
  }
  // XLSX is also a zip; openpyxl validates the inner structure.
  if (ext === "xlsx" && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    return "xlsx";
  }
  if (ext === "pptx" && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    return "pptx";
  }
  // Images — accept any extension in the allowed list whose magic
  // bytes match the format. This catches the renamed-extension case
  // (e.g. JPEG saved as .png) by checking the actual bytes.
  if (IMAGE_EXTS.has(ext) && _isImageMagic(buf)) {
    return "image";
  }
  return null;
}

function _isImageMagic(buf: Buffer): boolean {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PNG_MAGIC)) return true;
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_MAGIC)) return true;
  if (buf.length >= 4 && buf.subarray(0, 4).equals(GIF_MAGIC)) return true;
  if (buf.length >= 2 && buf.subarray(0, 2).equals(BMP_MAGIC)) return true;
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }
  if (buf.length >= 4 && (buf.subarray(0, 4).equals(TIFF_LE) || buf.subarray(0, 4).equals(TIFF_BE))) {
    return true;
  }
  return false;
}

// The POST now returns a job handle immediately; the finished document
// is fetched by polling /api/import/status/[jobId].
interface AcceptedResponse {
  job_id: string;
  session_id: string;
  filename: string;
  size: number;
  format: Format;
}

interface ErrorResponse {
  error: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<AcceptedResponse | ErrorResponse>> {
  const ip = clientIp(req);
  const decision = checkRateLimit(ip, "/api/import");
  if (!decision.allowed) {
    await recordEvent({
      event: "rate-limited",
      route: "/api/import",
      ip_hash: hashIp(ip),
      status: 429,
    });
    return NextResponse.json(
      { error: `rate limit — retry in ${decision.retryAfterSec}s` },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } }
    );
  }

  // Concurrency guards (protect the shared VPS). Rejected early, before
  // we buffer/parse the upload. Per-IP cap stops one client flooding the
  // queue; the global cap is a last-resort backpressure valve.
  const ipHash = hashIp(ip);
  if (activeJobCount() >= MAX_ACTIVE_GLOBAL) {
    return NextResponse.json(
      { error: "server busy — please try again in a moment" },
      { status: 503, headers: { "Retry-After": "10" } }
    );
  }
  if (activeJobCountForIp(ipHash) >= MAX_ACTIVE_PER_IP) {
    return NextResponse.json(
      { error: "too many imports in progress — let your current ones finish" },
      { status: 429, headers: { "Retry-After": "10" } }
    );
  }

  // Best-effort sweep of stale uploads + closed tickets. Lazy so we
  // don't need an external cron; sweep_interval keeps the cost low.
  const { publicUploads, ticketsRoot } = paths();
  maybeSweep(publicUploads, ticketsRoot).catch(() => {
    /* best-effort */
  });

  // Early-reject anything obviously over the cap by Content-Length so
  // we don't buffer multi-GB uploads into memory before discovering
  // they're too big. The post-parse file.size check below is the
  // authoritative one (header can lie).
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: `File too large; max ${MAX_FILE_BYTES / 1024 / 1024} MB` },
      { status: 413 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Field 'file' missing or not a file" }, { status: 400 });
  }
  // Optional password for encrypted PDFs. Only forwarded for the PDF
  // adapter; the others ignore it.
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : null;
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large; max ${MAX_FILE_BYTES / 1024 / 1024} MB` },
      { status: 413 }
    );
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const format = detectFormat(buf, file.name);
  if (format === null) {
    return NextResponse.json(
      { error: "Unsupported file type — supported: PDF, DOCX, XLSX, PPTX, MD, HTML, EPUB, PNG/JPG/WebP/GIF/BMP/TIFF" },
      { status: 415 }
    );
  }
  const adapter = ADAPTERS[format];

  const sessionId = randomUUID();
  const { servicesRoot } = paths();
  const sessionDir = join(publicUploads, sessionId);
  await mkdir(sessionDir, { recursive: true });

  // The image format covers many extensions (png/jpg/webp/...); keep
  // the original so PIL sniffs the right decoder and so the data URL
  // mime type matches what was uploaded.
  const sourceExt =
    format === "image"
      ? (file.name.toLowerCase().split(".").pop() || "png")
      : format;
  const sourcePath = join(sessionDir, `source.${sourceExt}`);
  const udmPath = join(sessionDir, "doc.udm.json");
  const assetsDir = join(sessionDir, "assets");
  const urlPrefix = `/uploads/${sessionId}/assets`;
  const sourceUrl = `/uploads/${sessionId}/source.${sourceExt}`;
  const pythonPath = resolve(servicesRoot, adapter.pythonPathSubdir);

  await writeFile(sourcePath, buf);

  // Enqueue the job and run the importer in the background. The Node
  // process is long-lived (systemd `next start`), so this keeps running
  // after we respond; the client polls /api/import/status/[jobId].
  const job = createImportJob({
    id: sessionId,
    filename: file.name,
    format,
    size: file.size,
    ipHash,
  });
  const heavy = isHeavyFormat(format);

  void (async () => {
    // Heavy (OCR) imports wait for a CPU slot; light ones run at once.
    // The job stays "queued" until the slot is acquired.
    if (heavy) await acquireHeavySlot();
    markImportJobRunning(job.id);
    const started = Date.now();
    try {
      await runImporter(
        adapter, sourcePath, udmPath, assetsDir, urlPrefix, sourceUrl, pythonPath, password
      );
      const ms = Date.now() - started;
      await recordEvent({
        event: "import",
        route: "/api/import",
        ip_hash: ipHash,
        format,
        bytes: file.size,
        ms,
        status: 200,
      });
      completeImportJob(job.id, {
        session_id: sessionId,
        udm_url: `/uploads/${sessionId}/doc.udm.json`,
        filename: file.name,
        size: file.size,
        format,
        ms_taken: ms,
        // True only when the user actually supplied a non-empty
        // password to unlock the source. Owner-only-encrypted PDFs
        // unlock with an empty password and don't count.
        had_password: !!password,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The Python CLI surfaces encrypted-PDF cases via exit code 4
      // and an "ENCRYPTED: <code>" stderr line so the client can
      // prompt for a password instead of showing a stack trace.
      if (msg.includes("ENCRYPTED: PASSWORD_REQUIRED")) {
        failImportJob(job.id, "password_required");
      } else if (msg.includes("ENCRYPTED: PASSWORD_WRONG")) {
        failImportJob(job.id, "password_wrong");
      } else {
        await recordEvent({
          event: "rejected",
          route: "/api/import",
          ip_hash: ipHash,
          format,
          bytes: file.size,
          status: 500,
          error: msg.slice(0, 200),
        });
        failImportJob(job.id, "error", `Importer failed: ${msg}`);
      }
    } finally {
      if (heavy) releaseHeavySlot();
    }
  })();

  return NextResponse.json(
    {
      job_id: job.id,
      session_id: sessionId,
      filename: file.name,
      size: file.size,
      format,
    },
    { status: 202 }
  );
}

function runImporter(
  adapter: AdapterSpec,
  input: string,
  output: string,
  assetsDir: string,
  urlPrefix: string,
  sourceUrl: string,
  pythonPath: string,
  password: string | null
): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const cliArgs = ["-m", adapter.module, input, "-o", output];
    if (adapter.extractsAssets) {
      cliArgs.push("--assets-dir", assetsDir, "--assets-url-prefix", urlPrefix);
    }
    // PDF adapter supports passthrough export. Office adapter does not yet.
    if (adapter.format === "pdf") {
      cliArgs.push("--source-url", sourceUrl);
      if (password) {
        cliArgs.push("--password", password);
      }
    }
    const proc = spawn("python", cliArgs, { env, windowsHide: true });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`timed out after ${SUBPROCESS_TIMEOUT_MS}ms`));
    }, SUBPROCESS_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve_();
      else reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
