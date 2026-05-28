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
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { maybeSweep } from "@/lib/upload-cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
// OCR of scanned pages runs at import time (~6-8 s/page via Tesseract),
// so the importer can legitimately take a while on multi-page scans.
const SUBPROCESS_TIMEOUT_MS = 180_000;
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\3\4 (DOCX/ODT/XLSX/PPTX)

type Format = "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx";

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
  return null;
}

interface ImportResponse {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  ms_taken: number;
}

interface ErrorResponse {
  error: string;
}

export async function POST(req: NextRequest): Promise<NextResponse<ImportResponse | ErrorResponse>> {
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

  // Best-effort sweep of stale uploads + closed tickets. Lazy so we
  // don't need an external cron; sweep_interval keeps the cost low.
  const { publicUploads, ticketsRoot } = paths();
  maybeSweep(publicUploads, ticketsRoot).catch(() => {
    /* best-effort */
  });

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
      { error: "Unsupported file type — supported: PDF, DOCX, XLSX, PPTX, MD, HTML, EPUB" },
      { status: 415 }
    );
  }
  const adapter = ADAPTERS[format];

  const sessionId = randomUUID();
  const { servicesRoot } = paths();
  const sessionDir = join(publicUploads, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const sourcePath = join(sessionDir, `source.${format}`);
  const udmPath = join(sessionDir, "doc.udm.json");
  const assetsDir = join(sessionDir, "assets");
  const urlPrefix = `/uploads/${sessionId}/assets`;
  const sourceUrl = `/uploads/${sessionId}/source.${format}`;
  const pythonPath = resolve(servicesRoot, adapter.pythonPathSubdir);

  await writeFile(sourcePath, buf);

  const started = Date.now();
  try {
    await runImporter(adapter, sourcePath, udmPath, assetsDir, urlPrefix, sourceUrl, pythonPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordEvent({
      event: "rejected",
      route: "/api/import",
      ip_hash: hashIp(ip),
      format,
      bytes: file.size,
      status: 500,
      error: msg.slice(0, 200),
    });
    return NextResponse.json({ error: `Importer failed: ${msg}` }, { status: 500 });
  }
  const ms = Date.now() - started;

  await recordEvent({
    event: "import",
    route: "/api/import",
    ip_hash: hashIp(ip),
    format,
    bytes: file.size,
    ms,
    status: 200,
  });

  return NextResponse.json({
    session_id: sessionId,
    udm_url: `/uploads/${sessionId}/doc.udm.json`,
    filename: file.name,
    size: file.size,
    format,
    ms_taken: ms,
  });
}

function runImporter(
  adapter: AdapterSpec,
  input: string,
  output: string,
  assetsDir: string,
  urlPrefix: string,
  sourceUrl: string,
  pythonPath: string
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
