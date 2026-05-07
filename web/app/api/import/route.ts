/**
 * POST /api/import
 *
 * Accepts a multipart/form-data upload with a PDF in the `file` field,
 * runs the Python pdf-adapter as a subprocess, and returns a URL to the
 * generated UDM JSON document.
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

// Resolved at request time so cwd changes don't matter.
function paths() {
  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  return {
    webRoot,
    repoRoot,
    pythonPath: resolve(repoRoot, "services", "pdf-adapter", "src"),
    publicUploads: resolve(webRoot, "public", "uploads"),
  };
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
  if (buf.length < 4 || !buf.subarray(0, 4).equals(PDF_MAGIC)) {
    return NextResponse.json({ error: "Not a PDF (missing %PDF header)" }, { status: 415 });
  }

  const sessionId = randomUUID();
  const { pythonPath, publicUploads } = paths();
  const sessionDir = join(publicUploads, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const pdfPath = join(sessionDir, "source.pdf");
  const udmPath = join(sessionDir, "doc.udm.json");
  const assetsDir = join(sessionDir, "assets");
  const urlPrefix = `/uploads/${sessionId}/assets`;

  await writeFile(pdfPath, buf);

  const started = Date.now();
  try {
    await runImporter(pdfPath, udmPath, assetsDir, urlPrefix, pythonPath);
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
    ms_taken: ms,
  });
}

function runImporter(
  input: string,
  output: string,
  assetsDir: string,
  urlPrefix: string,
  pythonPath: string
): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const proc = spawn(
      "python",
      [
        "-m",
        "pdf_adapter.cli",
        input,
        "-o",
        output,
        "--assets-dir",
        assetsDir,
        "--assets-url-prefix",
        urlPrefix,
      ],
      { env, windowsHide: true }
    );

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
