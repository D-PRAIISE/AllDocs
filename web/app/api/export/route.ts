/**
 * GET /api/export?udm=<relative-public-url>
 *
 * Reads a UDM JSON file from web/public/ (the path supplied as `udm`),
 * runs the Python pdf-adapter exporter, and returns the resulting PDF
 * as the response body.
 *
 * Security:
 *   - Only paths inside web/public/ are accepted (path-traversal blocked).
 *   - 60 s subprocess timeout.
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SUBPROCESS_TIMEOUT_MS = 45_000;

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
    await runExporter(udmPath, outputPdf, pythonPath);
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

function runExporter(udmPath: string, outputPdf: string, pythonPath: string): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const proc = spawn(
      "python",
      ["-m", "pdf_adapter.cli", "--export", udmPath, "-o", outputPdf],
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

function deriveFilename(udmUrl: string): string {
  const last = udmUrl.split("/").filter(Boolean).pop() ?? "exported";
  const base = last.replace(/\.udm\.json$/i, "").replace(/\.json$/i, "") || "exported";
  // Strip anything that's not alnum/dash/underscore for header safety.
  const safe = base.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}.pdf`;
}
