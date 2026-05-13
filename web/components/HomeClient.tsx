"use client";

import { useCallback, useEffect, useState } from "react";

import type { Block, Document, FlowContent } from "@/lib/udm";
import { FlowEditor } from "./FlowEditor";
import { UdmViewer } from "./UdmViewer";
import { UploadZone } from "./UploadZone";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: "pdf" | "docx";
  ms_taken: number;
}

const DEFAULT_SRC = "/synthetic.udm.json";

export function HomeClient() {
  const [src, setSrc] = useState<string>(DEFAULT_SRC);
  const [meta, setMeta] = useState<UploadResult | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [draftDoc, setDraftDoc] = useState<Document | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the UDM whenever `src` changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDoc(null);
    setDraftDoc(null);
    setIsDirty(false);
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${src}: ${r.status}`);
        return r.json() as Promise<Document>;
      })
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setDraftDoc(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const handleUploaded = useCallback((result: UploadResult) => {
    setSrc(result.udm_url);
    setMeta(result);
    setIsEditing(false);
  }, []);

  const handleEditedBlocks = useCallback(
    (blocks: Block[]) => {
      if (!draftDoc) return;
      const next: Document = {
        ...draftDoc,
        content: { ...(draftDoc.content as FlowContent), blocks } as FlowContent,
      };
      setDraftDoc(next);
      setIsDirty(true);
    },
    [draftDoc]
  );

  const handleSave = useCallback(() => {
    setDoc(draftDoc);
    setIsDirty(false);
    setIsEditing(false);
  }, [draftDoc]);

  const handleDiscard = useCallback(() => {
    setDraftDoc(doc);
    setIsDirty(false);
    setIsEditing(false);
  }, [doc]);

  const downloadExport = useCallback(
    async (endpoint: "/api/export" | "/api/export-docx", ext: "pdf" | "docx") => {
      if (!doc) return;
      setIsDownloading(true);
      setError(null);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udm: doc }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const base = (meta?.filename ?? "document").replace(/\.[a-z0-9]+$/i, "");
        const a = document.createElement("a");
        a.href = url;
        a.download = `${base}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsDownloading(false);
      }
    },
    [doc, meta]
  );

  const handleDownloadPdf = useCallback(
    () => downloadExport("/api/export", "pdf"),
    [downloadExport]
  );
  const handleDownloadDocx = useCallback(
    () => downloadExport("/api/export-docx", "docx"),
    [downloadExport]
  );

  const resetToSynthetic = useCallback(() => {
    setSrc(DEFAULT_SRC);
    setMeta(null);
    setIsEditing(false);
  }, []);

  const canEdit = doc?.mode === "flow";
  const showDownload = doc !== null && (doc.mode === "fixed" || doc.mode === "flow");

  return (
    <div className="space-y-6">
      <UploadZone onUploaded={handleUploaded} />
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {meta ? (
          <span className="text-neutral-500 font-mono">
            Loaded: {meta.filename} · {meta.format.toUpperCase()} ·{" "}
            {(meta.size / 1024).toFixed(1)} KB · imported in {meta.ms_taken} ms · session{" "}
            <span className="text-neutral-400">{meta.session_id.slice(0, 8)}</span>
          </span>
        ) : (
          <span className="text-neutral-500 font-mono">
            Showing built-in synthetic fixture.
          </span>
        )}

        {canEdit && !isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="px-3 py-1.5 bg-neutral-900 text-white rounded text-sm font-medium hover:bg-neutral-700 transition"
          >
            Edit
          </button>
        )}

        {isEditing && (
          <>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={`px-3 py-1.5 rounded text-sm font-medium transition ${
                isDirty
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "bg-neutral-200 text-neutral-400 cursor-not-allowed"
              }`}
            >
              Save changes
            </button>
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 bg-white text-neutral-700 border border-neutral-300 rounded text-sm font-medium hover:border-neutral-500 transition"
            >
              {isDirty ? "Discard" : "Done editing"}
            </button>
            {isDirty && (
              <span className="text-amber-700 text-xs">Unsaved changes</span>
            )}
          </>
        )}

        {showDownload && !isEditing && (
          <>
            <button
              onClick={handleDownloadPdf}
              disabled={isDownloading}
              className="px-3 py-1.5 bg-amber-500 text-neutral-900 rounded text-sm font-medium hover:bg-amber-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDownloading ? "Exporting..." : "Download as PDF"}
            </button>
            {doc.mode === "flow" && (
              <button
                onClick={handleDownloadDocx}
                disabled={isDownloading}
                className="px-3 py-1.5 bg-white text-neutral-700 border border-neutral-300 rounded text-sm font-medium hover:border-neutral-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download as DOCX
              </button>
            )}
          </>
        )}

        {meta && (
          <button
            onClick={resetToSynthetic}
            className="underline text-neutral-500 hover:text-neutral-700"
          >
            reset to synthetic
          </button>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {doc === null && !error && (
        <div className="p-6 text-neutral-500">Loading {src}...</div>
      )}

      {doc !== null && draftDoc !== null && (
        isEditing && doc.mode === "flow" ? (
          <FlowEditor
            initialBlocks={(doc.content as FlowContent).blocks}
            onChange={handleEditedBlocks}
          />
        ) : (
          <UdmViewer doc={doc} />
        )
      )}
    </div>
  );
}
