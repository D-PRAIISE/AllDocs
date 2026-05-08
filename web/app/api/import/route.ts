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

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const SUBPROCESS_TIMEOUT_MS = 45_000;
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\3\4 (DOCX/ODT/XLSX/PPTX)

type Format = "pdf" | "docx";

interface AdapterSpec {
  format: Format;
  module: string;
  pythonPathSubdir: string;
  // PDF supports asset extraction; DOCX doesn't yet (v0.2).
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
};

function paths() {
  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  return {
    webRoot,
    repoRoot,
    servicesRoot: resolve(repoRoot, "services"),
    publicUploads: resolve(webRoot, "public", "uploads"),
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
      { error: "Unsupported file type — PDF or DOCX only (matched by extension + magic bytes)" },
      { status: 415 }
    );
  }
  const adapter = ADAPTERS[format];

  const sessionId = randomUUID();
  const { servicesRoot, publicUploads } = paths();
  const sessionDir = join(publicUploads, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const sourcePath = join(sessionDir, `source.${format}`);
  const udmPath = join(sessionDir, "doc.udm.json");
  const assetsDir = join(sessionDir, "assets");
  const urlPrefix = `/uploads/${sessionId}/assets`;
  const pythonPath = resolve(servicesRoot, adapter.pythonPathSubdir);

  await writeFile(sourcePath, buf);

  const started = Date.now();
  try {
    await runImporter(adapter, sourcePath, udmPath, assetsDir, urlPrefix, pythonPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Importer failed: ${msg}` }, { status: 500 });
  }
  const ms = Date.now() - started;

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
  pythonPath: string
): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const cliArgs = ["-m", adapter.module, input, "-o", output];
    if (adapter.extractsAssets) {
      cliArgs.push("--assets-dir", assetsDir, "--assets-url-prefix", urlPrefix);
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
