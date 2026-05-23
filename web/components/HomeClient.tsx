"use client";

import { useCallback, useEffect, useState } from "react";

import type { Block, Document, FlowContent } from "@/lib/udm";
import { FixedEditor } from "./FixedEditor";
import { FlowEditor } from "./FlowEditor";
import { DocumentSummary, FontFaceStyles, UdmViewer } from "./UdmViewer";
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

  const handleEditedDoc = useCallback(
    (next: Document) => {
      setDraftDoc(next);
      setIsDirty(true);
    },
    []
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

  const canEdit = doc?.mode === "flow" || doc?.mode === "fixed";
  const showDownload = doc !== null && (doc.mode === "fixed" || doc.mode === "flow");

  return (
    <div className="space-y-6">
      <UploadZone onUploaded={handleUploaded} />

      <div className="border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 border-b border-border">
          <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted">
            {meta ? "session" : "default"}
          </div>
          {meta ? (
            <div className="font-mono text-xs text-fg">
              {meta.filename}{" "}
              <span className="text-muted">·</span>{" "}
              <span className="text-accent">{meta.format}</span>{" "}
              <span className="text-muted">·</span>{" "}
              {(meta.size / 1024).toFixed(1)}KB{" "}
              <span className="text-muted">·</span>{" "}
              {meta.ms_taken}ms{" "}
              <span className="text-muted">·</span>{" "}
              <span className="text-subtle">{meta.session_id.slice(0, 8)}</span>
            </div>
          ) : (
            <div className="font-mono text-xs text-muted">
              built-in synthetic fixture
            </div>
          )}
          {meta && (
            <button
              onClick={resetToSynthetic}
              className="ml-auto font-mono text-[0.65rem] uppercase tracking-wider text-subtle hover:text-muted underline-offset-4 hover:underline"
            >
              reset to synthetic
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {canEdit && !isEditing && (
            <button onClick={() => setIsEditing(true)} className="btn-ghost">
              edit
            </button>
          )}

          {isEditing && (
            <>
              <button
                onClick={handleSave}
                disabled={!isDirty}
                className="btn-success"
              >
                save
              </button>
              <button onClick={handleDiscard} className="btn-ghost">
                {isDirty ? "discard" : "done"}
              </button>
              {isDirty && (
                <span className="font-mono text-[0.65rem] uppercase tracking-wider text-warn">
                  unsaved changes
                </span>
              )}
            </>
          )}

          {showDownload && !isEditing && (
            <>
              <button
                onClick={handleDownloadPdf}
                disabled={isDownloading}
                className="btn-primary"
              >
                {isDownloading ? "exporting…" : "↓ pdf"}
              </button>
              <button
                onClick={handleDownloadDocx}
                disabled={isDownloading}
                className="btn-ghost"
              >
                ↓ docx
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="border border-error/40 bg-error/10 px-4 py-3 font-mono text-xs text-error">
          {error}
        </div>
      )}

      {doc === null && !error && (
        <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
          loading {src}…
        </div>
      )}

      {doc !== null && draftDoc !== null && (
        isEditing && doc.mode === "flow" ? (
          <FlowEditor
            initialBlocks={(doc.content as FlowContent).blocks}
            onChange={handleEditedBlocks}
          />
        ) : isEditing && doc.mode === "fixed" ? (
          <div className="space-y-4">
            <FontFaceStyles resources={draftDoc.resources} />
            <DocumentSummary doc={draftDoc} />
            <FixedEditor doc={draftDoc} onChange={handleEditedDoc} />
          </div>
        ) : (
          <UdmViewer doc={doc} />
        )
      )}
    </div>
  );
}
