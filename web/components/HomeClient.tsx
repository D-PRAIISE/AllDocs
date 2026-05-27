"use client";

import { useCallback, useEffect, useState } from "react";

import type { Block, Document, FlowContent } from "@/lib/udm";
import { useHistory } from "@/lib/use-doc-history";
import { FixedEditor } from "./FixedEditor";
import { FlowEditor } from "./FlowEditor";
import { ReportProblemModal } from "./ReportProblemModal";
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

// Placeholder while no doc is loaded — the history hook needs a value
// to initialise with even before fetch resolves.
const EMPTY_DOC: Document = {
  schema_version: 0,
  mode: "fixed",
  metadata: { title: "" },
  resources: { fonts: [], images: [], styles: [], colors: [] },
  content: { kind: "fixed", pages: [] },
} as unknown as Document;

export function HomeClient() {
  const [src, setSrc] = useState<string>(DEFAULT_SRC);
  const [meta, setMeta] = useState<UploadResult | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const draft = useHistory<Document>(EMPTY_DOC);
  const [isEditing, setIsEditing] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDoc(null);
    setIsDirty(false);
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${src}: ${r.status}`);
        return r.json() as Promise<Document>;
      })
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        draft.reset(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // draft is intentionally omitted — reset is stable enough and we
    // only want this to fire on src change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const handleUploaded = useCallback((result: UploadResult) => {
    setSrc(result.udm_url);
    setMeta(result);
    setIsEditing(false);
  }, []);

  const handleEditedBlocks = useCallback(
    (blocks: Block[]) => {
      const current = draft.state;
      if (!current) return;
      const next: Document = {
        ...current,
        content: { ...(current.content as FlowContent), blocks } as FlowContent,
      };
      // TipTap owns its own undo for in-editor ops; we coalesce all flow
      // edits under one key so our top-level history doesn't compete.
      draft.set(next, "flow-edit");
      setIsDirty(true);
    },
    [draft]
  );

  const handleEditedDoc = useCallback(
    (next: Document, coalesceKey?: string) => {
      draft.set(next, coalesceKey);
      setIsDirty(true);
    },
    [draft]
  );

  const handleEnterEdit = useCallback(() => {
    if (doc) draft.reset(doc);
    setIsEditing(true);
    setIsDirty(false);
  }, [doc, draft]);

  const handleSave = useCallback(() => {
    setDoc(draft.state);
    setIsDirty(false);
    setIsEditing(false);
  }, [draft.state]);

  const handleDiscard = useCallback(() => {
    if (doc) draft.reset(doc);
    setIsDirty(false);
    setIsEditing(false);
  }, [doc, draft]);

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo. Only active
  // in fixed-mode editing — flow mode delegates to TipTap's own history,
  // and we don't want our top-level shortcut to fight ProseMirror's.
  useEffect(() => {
    if (!isEditing) return;
    if (doc?.mode !== "fixed") return;
    // The FixedEditor's contentEditable is exactly where the user is
    // most likely to want undo, so we deliberately don't bail on
    // input/textarea/contentEditable targets — we want our top-level
    // history to win even mid-typing.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        draft.undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        draft.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isEditing, doc, draft]);

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
  // Only surface our top-level undo/redo for fixed mode — flow has
  // TipTap's own undo on its toolbar.
  const showHistoryControls = isEditing && doc?.mode === "fixed";

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
            <button onClick={handleEnterEdit} className="btn-ghost">
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
              {showHistoryControls && (
                <>
                  <span className="w-px h-5 bg-border mx-1" />
                  <button
                    onClick={draft.undo}
                    disabled={!draft.canUndo}
                    title="Undo (Ctrl+Z)"
                    aria-label="Undo last change"
                    className="btn-ghost"
                  >
                    ↶ undo
                  </button>
                  <button
                    onClick={draft.redo}
                    disabled={!draft.canRedo}
                    title="Redo (Ctrl+Shift+Z)"
                    aria-label="Redo last undo"
                    className="btn-ghost"
                  >
                    ↷ redo
                  </button>
                </>
              )}
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

          {/* Report-a-problem is available the moment a doc is loaded,
              including mid-edit — the user might be reporting something
              that's broken right now in their editor state. */}
          {doc !== null && (
            <button
              onClick={() => setReportOpen(true)}
              className="ml-auto font-mono text-[0.65rem] uppercase tracking-wider text-subtle hover:text-muted underline-offset-4 hover:underline"
              title="Report a problem with this document"
            >
              ⚐ report a problem
            </button>
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

      {doc !== null && (
        isEditing && doc.mode === "flow" ? (
          <FlowEditor
            initialBlocks={(doc.content as FlowContent).blocks}
            onChange={handleEditedBlocks}
          />
        ) : isEditing && doc.mode === "fixed" ? (
          <div className="space-y-4">
            <FontFaceStyles resources={draft.state.resources} />
            <DocumentSummary doc={draft.state} />
            <FixedEditor doc={draft.state} onChange={handleEditedDoc} />
          </div>
        ) : (
          <UdmViewer doc={doc} />
        )
      )}

      <ReportProblemModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        doc={isEditing ? draft.state : doc}
        sourceUrl={
          meta ? `/uploads/${meta.session_id}/source.${meta.format}` : null
        }
        sourceFilename={meta?.filename ?? null}
        sessionId={meta?.session_id ?? null}
      />
    </div>
  );
}
