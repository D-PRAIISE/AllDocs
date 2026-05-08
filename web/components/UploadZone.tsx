"use client";

import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: "pdf" | "docx";
  ms_taken: number;
}

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ALLOWED_EXTS = [".pdf", ".docx"];

interface UploadZoneProps {
  onUploaded: (result: UploadResult) => void;
}

export function UploadZone({ onUploaded }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setProgress(`Uploading ${file.name} (${formatBytes(file.size)})...`);
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
        setProgress(`Imported in ${result.ms_taken} ms`);
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
      const ok = ALLOWED_EXTS.some((ext) => lower.endsWith(ext));
      if (!ok) {
        setError("Supported: PDF and DOCX");
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
      className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        isDragging
          ? "border-amber-500 bg-amber-50"
          : "border-neutral-300 bg-white hover:border-neutral-400"
      }`}
    >
      {isUploading ? (
        <div className="text-neutral-700">
          <div className="font-medium">Importing...</div>
          {progress && <div className="text-xs text-neutral-500 mt-1">{progress}</div>}
        </div>
      ) : (
        <>
          <div className="text-neutral-700 font-medium">Drop a PDF or DOCX here</div>
          <div className="text-xs text-neutral-400 my-2">or</div>
          <label className="inline-block px-4 py-2 bg-neutral-900 text-white rounded cursor-pointer hover:bg-neutral-700 text-sm">
            Choose file
            <input type="file" accept={ACCEPT} className="hidden" onChange={onChange} />
          </label>
          {progress && !error && (
            <div className="mt-3 text-xs text-emerald-700">{progress}</div>
          )}
          {error && <div className="mt-3 text-sm text-red-700">{error}</div>}
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
