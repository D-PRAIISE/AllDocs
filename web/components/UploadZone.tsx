"use client";

import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx";
  ms_taken: number;
}

interface UploadZoneProps {
  onUploaded: (result: UploadResult) => void;
}

const ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.md,.markdown,.html,.htm,.epub,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/markdown,text/html,application/epub+zip";
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
];

export function UploadZone({ onUploaded }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setProgress(`uploading ${file.name} (${formatBytes(file.size)})`);
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/import", { method: "POST", body: formData });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        const result = (await res.json()) as UploadResult;
        setProgress(`imported in ${result.ms_taken}ms`);
        onUploaded(result);
      } catch (e) {
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
        setError("supported formats: pdf, docx, xlsx, pptx, md, html, epub");
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
      ) : (
        <div className="space-y-3">
          <div className="font-mono text-xs uppercase tracking-wider text-muted">
            drop a file
          </div>
          <div className="font-sans text-lg text-fg">
            PDF · DOCX · XLSX · PPTX · Markdown · HTML · EPUB
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
