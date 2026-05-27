/**
 * POST /api/export-xlsx
 *
 * Body: { udm: Document } where Document.mode === "sheet".
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SUBPROCESS_TIMEOUT_MS = 30_000;
const MAX_POST_BYTES = 32 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_POST_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const udm = (body as { udm?: unknown } | null)?.udm;
  if (!udm || typeof udm !== "object") {
    return NextResponse.json({ error: "body must be { udm: Document }" }, { status: 400 });
  }
  if ((udm as { mode?: unknown }).mode !== "sheet") {
    return NextResponse.json(
      { error: `XLSX export requires mode='sheet'; got mode=${JSON.stringify((udm as { mode?: unknown }).mode)}` },
      { status: 400 }
    );
  }

  const webRoot = process.cwd();
  const repoRoot = resolve(webRoot, "..");
  const pythonPath = resolve(repoRoot, "services", "office-adapter", "src");
  const tmp = await mkdtemp(join(tmpdir(), "alldocs-export-xlsx-"));
  const udmPath = join(tmp, "doc.udm.json");
  const outputPath = join(tmp, "output.xlsx");

  try {
    await writeFile(udmPath, JSON.stringify(udm));
    await runExporter(udmPath, outputPath, pythonPath);
    const bytes = await readFile(outputPath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": 'attachment; filename="exported.xlsx"',
        "Content-Length": String(bytes.length),
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

function runExporter(udmPath: string, outputPath: string, pythonPath: string): Promise<void> {
  return new Promise((resolve_, reject) => {
    const env = { ...process.env, PYTHONPATH: pythonPath };
    const proc = spawn(
      "python",
      ["-m", "office_adapter.cli", "--export", udmPath, "-o", outputPath],
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
