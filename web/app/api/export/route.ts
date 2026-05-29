/**
 * /api/export
 *
 *   GET ?udm=<relative-public-url>
 *     Reads a UDM JSON file from web/public/ (the path supplied as `udm`),
 *     runs the exporter, returns the PDF.
 *
 *   POST  body: { udm: Document }
 *     Accepts a UDM document directly (used for downloading edited
 *     documents). Asset data_refs in the UDM are resolved against
 *     web/public/ — i.e. the same root as GET — so URLs like
 *     "synthetic.assets/images/img_000.png" or "/uploads/<id>/assets/..."
 *     resolve to real files on disk.
 *
 * Security:
 *   - GET: only paths inside web/public/ are accepted.
 *   - POST: payload size capped at 10 MB.
 *   - 60 s subprocess timeout.
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applyApiGuards, logRejection, logSuccess } from "@/lib/api-guards";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SUBPROCESS_TIMEOUT_MS = 45_000;
// 32 MB: a replaced image is embedded in the UDM as a base64 data URL
// (~4/3 of the file size), so the POST body can be substantially larger
// than a plain UDM document.
const MAX_POST_BYTES = 32 * 1024 * 1024;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const udmParam = url.searchParams.get("udm");
  if (!udmParam) {
    return NextResponse.json({ error: "missing 'udm' query parameter" }, { status: 400 });
  }

  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  const pythonPath = resolve(repoRoot, "services", "pdf-adapter", "src");
  const publicDir = resolve(webRoot, "public");

  // Anchor the UDM path inside web/public/. Strip leading slashes so
  // ".../public/" + "uploads/x.json" resolves correctly; reject anything
  // that escapes the public root after normalization.
  const udmPath = resolve(publicDir, udmParam.replace(/^\/+/, ""));
  if (udmPath !== publicDir && !udmPath.startsWith(publicDir + (process.platform === "win32" ? "\\" : "/"))) {
    return NextResponse.json({ error: "path traversal blocked" }, { status: 400 });
  }

  try {
    await stat(udmPath);
  } catch {
    return NextResponse.json({ error: "UDM file not found" }, { status: 404 });
  }

  const tmp = await mkdtemp(join(tmpdir(), "alldocs-export-"));
  const outputPdf = join(tmp, "output.pdf");

  try {
    // base_dir = publicDir so passthrough source_urls (e.g.
    // "/uploads/<id>/source.pdf") and asset URLs resolve to real files.
    // GET path never sets a password (it's the open-from-disk shortcut
    // used for browser-side links, not the user-driven download flow).
    await runExporter(udmPath, outputPdf, pythonPath, publicDir, null);
    const pdfBytes = await readFile(outputPdf);

    const filename = deriveFilename(udmParam);
    return new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `export failed: ${msg}` }, { status: 500 });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await applyApiGuards(req, "/api/export");
  if (!guard.allowed) return guard.response;

  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_POST_BYTES) {
    logRejection("/api/export", guard.ipHash, 413, "payload too large");
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let body: { udm?: unknown; password?: unknown };
  try {
    body = (await req.json()) as { udm?: unknown; password?: unknown };
  } catch {
    logRejection("/api/export", guard.ipHash, 400, "invalid JSON");
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const udm = body.udm;
  if (!udm || typeof udm !== "object") {
    logRejection("/api/export", guard.ipHash, 400, "missing udm");
    return NextResponse.json({ error: "missing 'udm' in body" }, { status: 400 });
  }
  // Optional encrypt-on-export password. Empty string = unprotected
  // (the user explicitly cleared the password); only forwarded when
  // non-empty so passthrough/render-without-encryption still apply.
  const password =
    typeof body.password === "string" && body.password.length > 0
      ? body.password
      : null;

  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  const pythonPath = resolve(repoRoot, "services", "pdf-adapter", "src");
  const publicDir = resolve(webRoot, "public");

  const tmp = await mkdtemp(join(tmpdir(), "alldocs-export-"));
  const udmPath = join(tmp, "doc.udm.json");
  const outputPdf = join(tmp, "output.pdf");

  const started = Date.now();
  try {
    await writeFile(udmPath, JSON.stringify(udm), "utf8");
    await runExporter(udmPath, outputPdf, pythonPath, publicDir, password);
    const pdfBytes = await readFile(outputPdf);
    logSuccess("/api/export", guard.ipHash, {
      event: "export",
      format: "pdf",
      bytes: pdfBytes.length,
      ms: Date.now() - started,
    });
    return new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="exported.pdf"`,
        "Content-Length": String(pdfBytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logRejection("/api/export", guard.ipHash, 500, msg);
    return NextResponse.json({ error: `export failed: ${msg}` }, { status: 500 });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function runExporter(
  udmPath: string,
  outputPdf: string,
  pythonPath: string,
  baseDir: string | undefined,
  password: string | null
): Promise<void> {
  return new Promise((resolve_, reject) => {
    // Password is passed via env var so it never lands in argv (visible
    // in `ps`) or shell history. Empty / unset = unprotected output.
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: pythonPath };
    if (password) env.ALLDOCS_EXPORT_PASSWORD = password;
    const args = ["-m", "pdf_adapter.cli", "--export", udmPath, "-o", outputPdf];
    if (baseDir) args.push("--base-dir", baseDir);
    const proc = spawn("python", args, { env, windowsHide: true });

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

function deriveFilename(udmUrl: string): string {
  const last = udmUrl.split("/").filter(Boolean).pop() ?? "exported";
  const base = last.replace(/\.udm\.json$/i, "").replace(/\.json$/i, "") || "exported";
  // Strip anything that's not alnum/dash/underscore for header safety.
  const safe = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}.pdf`;
}
