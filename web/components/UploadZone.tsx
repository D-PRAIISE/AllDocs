"use client";

import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";

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

export function UploadZone({ onUploaded }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
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
      setProgress(`uploading ${file.name} (${formatBytes(file.size)})`);
      setIsUploading(true);
      const ext = file.name.toLowerCase().split(".").pop() || "unknown";
      try {
        const formData = new FormData();
        formData.append("file", file);
        if (password) formData.append("password", password);
        const res = await fetch("/api/import", { method: "POST", body: formData });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as
            | { error?: string; code?: string }
            | null;
          // Encrypted-PDF flow: bring up the password prompt instead
          // of surfacing the error generically. The user can retry
          // any number of times — each retry is rate-limited like a
          // fresh import call.
          if (j?.code === "password_required" || j?.code === "password_wrong") {
            setPasswordPrompt({
              file,
              message:
                j.code === "password_wrong"
                  ? "wrong password — try again"
                  : "this PDF is password-protected",
            });
            setProgress(null);
            setIsUploading(false);
            return;
          }
          track("import_failed", {
            route: "/api/import",
            status: res.status,
            mode: ext,
          });
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        const result = (await res.json()) as UploadResult;
        setProgress(`imported in ${result.ms_taken}ms`);
        setPasswordPrompt(null);
        onUploaded(result);
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
      className={`border border-dashed p-10 text-center transition-colors ${
        isDragging
          ? "border-accent bg-accent/5"
          : isUploading
            ? "border-border bg-surface"
            : "border-border-strong bg-surface hover:border-fg"
      }`}
    >
      {isUploading ? (
        <div className="space-y-2" role="status" aria-live="polite">
          <div className="font-mono text-xs uppercase tracking-wider text-accent">
            importing…
          </div>
          {progress && <div className="font-mono text-xs text-muted">{progress}</div>}
        </div>
      ) : passwordPrompt ? (
        <PasswordPrompt
          message={passwordPrompt.message}
          filename={passwordPrompt.file.name}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={(pw) => upload(passwordPrompt.file, pw)}
        />
      ) : (
        <div className="space-y-3">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            drop a file
          </div>
          <div className="font-sans text-lg text-fg">
            PDF · DOCX · XLSX · PPTX · Markdown · HTML · EPUB · images
          </div>
          <div className="font-mono text-[0.65rem] text-subtle">or</div>
          <label className="btn-primary inline-flex cursor-pointer">
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
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
