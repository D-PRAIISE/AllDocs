/**
 * POST /api/export-md
 *
 * Body: { udm: Document } where Document.mode === "flow".
 *
 * Hands the UDM to the text-adapter's Markdown exporter and returns
 * the resulting .md file as a download.
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applyApiGuards, logRejection, logSuccess } from "@/lib/api-guards";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const SUBPROCESS_TIMEOUT_MS = 30_000;
const MAX_POST_BYTES = 16 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await applyApiGuards(req, "/api/export-md");
  if (!guard.allowed) return guard.response;

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_POST_BYTES) {
      logRejection("/api/export-md", guard.ipHash, 413, "payload too large");
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    logRejection("/api/export-md", guard.ipHash, 400, "invalid JSON");
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const udm = (body as { udm?: unknown } | null)?.udm;
  if (!udm || typeof udm !== "object") {
    logRejection("/api/export-md", guard.ipHash, 400, "missing udm");
    return NextResponse.json(
      { error: "body must be { udm: Document }" },
      { status: 400 }
    );
  }
  if ((udm as { mode?: unknown }).mode !== "flow") {
    logRejection("/api/export-md", guard.ipHash, 400, "wrong mode");
    return NextResponse.json(
      { error: `Markdown export requires mode='flow'; got mode=${JSON.stringify((udm as { mode?: unknown }).mode)}` },
      { status: 400 }
    );
  }

  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  const pythonPath = resolve(repoRoot, "services", "text-adapter", "src");
  const tmp = await mkdtemp(join(tmpdir(), "alldocs-export-md-"));
  const udmPath = join(tmp, "doc.udm.json");
  const outputPath = join(tmp, "output.md");

  const started = Date.now();
  try {
    await writeFile(udmPath, JSON.stringify(udm));
    await runTextExporter(udmPath, outputPath, pythonPath);
    const bytes = await readFile(outputPath);
    logSuccess("/api/export-md", guard.ipHash, {
      event: "export",
      format: "md",
      bytes: bytes.length,
      ms: Date.now() - started,
    });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="exported.md"',
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logRejection("/api/export-md", guard.ipHash, 500, msg);
    return NextResponse.json({ error: `export failed: ${msg}` }, { status: 500 });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function runTextExporter(
  udmPath: string,
  outputPath: string,
  pythonPath: string
): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const proc = spawn(
      "python",
      ["-m", "text_adapter.cli", "--export", udmPath, "-o", outputPath],
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
