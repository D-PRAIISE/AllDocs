"use client";

import { useCallback, useEffect, useState, type ChangeEvent, type DragEvent } from "react";

import { track } from "@/lib/telemetry";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx" | "image";
  ms_taken: number;
  had_password?: boolean;
}

interface UploadZoneProps {
  onUploaded: (result: UploadResult) => void;
}

const ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.md,.markdown,.html,.htm,.epub," +
  ".png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff," +
  "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation," +
  "text/markdown,text/html,application/epub+zip,image/*";
const ALLOWED_EXTS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".epub",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
];

// Stage copy shown while an import is in flight.
//
// These track the real pipeline rather than inventing plausible-sounding
// steps: the order below is the order importer.py actually works in,
// and the slow ones are slow because profiling says so — building a
// text page costs ~0.3s each and re-encoding an image ~0.1s each, which
// on a 27-page illustrated manual is most of the wait.
//
// At STAGE_SECS each these carry the user through a long import; after
// the list runs out we switch to an honest rotating "still working"
// line plus elapsed seconds, rather than freezing on a fake
// "almost there". Imports run as a background job and a big scanned
// document can legitimately take minutes.
const IMPORT_STAGES = [
  "uploading your file…",
  "spawning the document adapter…",
  "sniffing the file format…",
  "checking whether the file is encrypted…",
  "validating the source structure…",
  "counting pages…",
  "parsing page content streams…",
  "building a text page for each page…",
  "detecting scanned vs. native text…",
  "running Tesseract OCR on scanned pages…",
  "recognizing characters and words…",
  "grouping words into lines…",
  "rebuilding the reading order…",
  "merging split line fragments…",
  "extracting embedded images…",
  "preserving soft-mask transparency…",
  "re-encoding masked images…",
  "resolving clip paths…",
  "capturing vector shapes and curves…",
  "working out what sits on top of what…",
  "extracting and subsetting fonts…",
  "matching fonts to metric-compatible clones…",
  "looking for fillable form fields…",
  "normalizing page geometry…",
  "mapping to the Universal Document Model…",
  "building editable text and layers…",
  "rendering your editable view…",
];
const STAGE_SECS = 3;

// Shown once the stage list is exhausted. Rotating, because a single
// frozen line reads as a hang — and each one has to stay true however
// long it ends up being displayed, so none of them promise it is nearly
// done.
const LONG_WAIT = [
  "still working — large or scanned files can take a few minutes",
  "big documents with many images take the longest",
  "every page is OCR'd separately, so page count drives the wait",
  "still going — the job is running, not stuck",
  "this stays open if you leave the tab; the work is server-side",
];
const LONG_WAIT_SECS = 6;

function stageMessage(elapsedSec: number): string {
  const i = Math.floor(elapsedSec / STAGE_SECS);
  if (i < IMPORT_STAGES.length) return IMPORT_STAGES[i];
  const over = Math.floor(
    (elapsedSec - IMPORT_STAGES.length * STAGE_SECS) / LONG_WAIT_SECS
  );
  return LONG_WAIT[Math.max(0, over) % LONG_WAIT.length];
}

export function UploadZone({ onUploaded }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  // True while the job is waiting for a CPU slot (server busy with other
  // heavy imports) — shown instead of the pipeline stages.
  const [queued, setQueued] = useState(false);

  // Tick an elapsed-seconds counter while uploading so the wait shows
  // honest progress (and drives the staged copy) instead of looking
  // frozen on a long OCR import.
  useEffect(() => {
    if (!isUploading) {
      setElapsedSec(0);
      setQueued(false);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isUploading]);
  // When the server tells us a PDF needs a password, hold the file in
  // memory and surface a password input until the user enters it (or
  // cancels). password === null means "no prompt pending".
  const [passwordPrompt, setPasswordPrompt] = useState<{
    file: File;
    message: string;
  } | null>(null);

  const upload = useCallback(
    async (file: File, password?: string): Promise<void> => {
      setError(null);
      setProgress(null);
      setIsUploading(true);
      const ext = file.name.toLowerCase().split(".").pop() || "unknown";
      try {
        const formData = new FormData();
        formData.append("file", file);
        if (password) formData.append("password", password);

        // The importer runs as a background job (OCR can take minutes,
        // past the Cloudflare ~100s timeout). POST returns a job_id we
        // poll until the document is ready.
        const res = await fetch("/api/import", { method: "POST", body: formData });
        if (!res.ok && res.status !== 202) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          track("import_failed", { route: "/api/import", status: res.status, mode: ext });
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        const { job_id } = (await res.json()) as { job_id: string };

        // The status endpoint long-polls (holds up to ~25s, resolving
        // the instant the job finishes), so each request blocks until
        // there's news — we just re-ask with a tiny gap if it returns
        // "running" (only happens on imports longer than the hold cap).
        const POLL_DEADLINE_MS = 12 * 60_000; // safety net past the server timeout
        const deadline = Date.now() + POLL_DEADLINE_MS;
        let first = true;
        for (;;) {
          await new Promise((r) => setTimeout(r, first ? 150 : 300));
          first = false;
          if (Date.now() > deadline) throw new Error("import timed out — please try again");

          const sres = await fetch(`/api/import/status/${job_id}`);
          if (sres.status === 404) throw new Error("import expired — please try again");
          const s = (await sres.json()) as {
            status: string;
            error?: string;
          } & Partial<UploadResult>;

          if (s.status === "password_required" || s.status === "password_wrong") {
            // Encrypted-PDF flow: prompt for the password and let the
            // user retry (a fresh import with the password attached).
            setPasswordPrompt({
              file,
              message:
                s.status === "password_wrong"
                  ? "wrong password — try again"
                  : "this PDF is password-protected",
            });
            return;
          }
          if (s.status === "error") {
            track("import_failed", { route: "/api/import", status: 500, mode: ext });
            throw new Error(s.error || "import failed");
          }
          if (s.status === "done") {
            setProgress(`imported in ${s.ms_taken}ms`);
            setPasswordPrompt(null);
            onUploaded(s as UploadResult);
            return;
          }
          // "queued" (waiting for a slot) vs "running" — keep polling.
          setQueued(s.status === "queued");
        }
      } catch (e) {
        if (e instanceof Error && e.name && e.name !== "Error") {
          track("import_threw", {
            route: "/api/import",
            error_class: e.name,
            mode: ext,
          });
        }
        setError(e instanceof Error ? e.message : String(e));
        setProgress(null);
      } finally {
        setIsUploading(false);
      }
    },
    [onUploaded]
  );

  const onFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      const lower = file.name.toLowerCase();
      if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
        setError("supported formats: pdf, docx, xlsx, pptx, md, html, epub, png/jpg/webp/gif/bmp/tiff");
        return;
      }
      void upload(file);
    },
    [upload]
  );

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => e.preventDefault();
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    onFiles(e.dataTransfer.files);
  };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => onFiles(e.target.files);

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`h-full flex flex-col items-center justify-center border border-dashed p-4 sm:p-6 text-center transition-colors ${
        isDragging
          ? "border-accent bg-accent/5"
          : isUploading
            ? "border-border bg-surface"
            : "border-border-strong bg-surface hover:border-fg"
      }`}
    >
      {isUploading ? (
        <div className="space-y-4 max-w-md mx-auto" role="status" aria-live="polite">
          <div className="font-mono text-xs uppercase tracking-wider text-accent">
            importing…
          </div>
          {/* Indeterminate sweep — the importer runs as a background
              job we poll, so we show motion + staged copy + an honest
              elapsed timer rather than fake percentages. */}
          <div className="relative h-1 w-full bg-border overflow-hidden">
            <div
              className="absolute top-0 h-full bg-accent"
              style={{ animation: "alldocs-sweep 1.4s ease-in-out infinite" }}
            />
          </div>
          <div className="font-sans text-sm text-fg/80">
            {queued
              ? "waiting for a free slot — the server is finishing other imports…"
              : stageMessage(elapsedSec)}
          </div>
          <div className="font-mono text-[0.65rem] text-subtle tabular-nums">
            {elapsedSec}s elapsed
          </div>
        </div>
      ) : passwordPrompt ? (
        <PasswordPrompt
          message={passwordPrompt.message}
          filename={passwordPrompt.file.name}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={(pw) => upload(passwordPrompt.file, pw)}
        />
      ) : (
        <div className="space-y-2 sm:space-y-3">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            {/* You can't drag a file on a phone, so don't open with an
                instruction the device can't follow. */}
            <span className="sm:hidden">open a document</span>
            <span className="hidden sm:inline">drop a file</span>
          </div>
          <div className="font-sans text-base sm:text-lg text-fg">
            {/* Full technical list on desktop; a grouped one-liner on
                mobile so it doesn't wrap into 2-3 lines in the box.
                The picker accepts every format either way. */}
            <span className="sm:hidden">PDF · Office · ebooks · images</span>
            <span className="hidden sm:inline">
              PDF · DOCX · XLSX · PPTX · Markdown · HTML · EPUB · images
            </span>
          </div>
          <div className="hidden sm:block font-mono text-[0.65rem] text-subtle">
            or
          </div>
          <label className="btn-primary inline-flex cursor-pointer justify-center w-full sm:w-auto h-11 sm:h-auto items-center">
            choose file
            <input type="file" accept={ACCEPT} className="hidden" onChange={onChange} />
          </label>
          {progress && !error && (
            <div className="font-mono text-xs text-success pt-2">{progress}</div>
          )}
          {error && (
            <div className="font-mono text-xs text-error pt-2">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function PasswordPrompt({
  message,
  filename,
  onSubmit,
  onCancel,
}: {
  message: string;
  filename: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <div className="space-y-3">
      <div className="font-mono text-xs uppercase tracking-wider text-warn">
        {message}
      </div>
      <div className="font-mono text-xs text-muted truncate" title={filename}>
        {filename}
      </div>
      <form
        className="flex items-center justify-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) onSubmit(pw);
        }}
      >
        <input
          type="password"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          placeholder="password"
          className="font-mono text-sm px-3 py-2 border border-border bg-input"
          style={{ color: "#111", caretColor: "#111", background: "#fff", minWidth: 220 }}
        />
        <button type="submit" className="btn-primary" disabled={!pw}>
          unlock
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost">
          cancel
        </button>
      </form>
      <div className="font-mono text-[0.6rem] text-subtle leading-relaxed pt-1 max-w-md mx-auto">
        AllDocs doesn&apos;t bypass real password protection. If this PDF
        only restricts editing/printing (no open password), we open it
        automatically — but this one needs a real password to read its
        contents.
      </div>
    </div>
  );
}
