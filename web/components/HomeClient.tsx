"use client";

import { useCallback, useEffect, useState } from "react";

import type { Block, Document, FlowContent, SheetContent, SlidesContent } from "@/lib/udm";
import { track } from "@/lib/telemetry";
import { useHistory } from "@/lib/use-doc-history";
import { ExportPasswordModal } from "./ExportPasswordModal";
import { FixedEditor } from "./FixedEditor";
import { FlowEditor } from "./FlowEditor";
import { ReportProblemModal } from "./ReportProblemModal";
import { SheetEditor } from "./SheetView";
import { SlideEditor } from "./SlideView";
import { FontFaceStyles, UdmViewer } from "./UdmViewer";
import { UploadZone } from "./UploadZone";

interface UploadResult {
  session_id: string;
  udm_url: string;
  filename: string;
  size: number;
  format: "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx" | "image";
  ms_taken: number;
  had_password?: boolean;
}

const DEFAULT_SRC = "/synthetic.udm.json";

/** One label/value cell in the session box's at-a-glance details. */
function GlanceField({
  label,
  value,
  accent,
  span2,
}: {
  label: string;
  value: string;
  accent?: boolean;
  span2?: boolean;
}) {
  return (
    <div className={span2 ? "col-span-2 sm:col-span-3 min-w-0" : "min-w-0"}>
      <dt className="font-mono text-[0.6rem] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd
        className={`mt-0.5 font-mono text-xs truncate ${accent ? "text-accent" : "text-fg"}`}
      >
        {value}
      </dd>
    </div>
  );
}

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
  const [exportPasswordOpen, setExportPasswordOpen] = useState(false);
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
    async (
      endpoint:
        | "/api/export"
        | "/api/export-docx"
        | "/api/export-md"
        | "/api/export-html"
        | "/api/export-epub"
        | "/api/export-xlsx"
        | "/api/export-pptx",
      ext: "pdf" | "docx" | "md" | "html" | "epub" | "xlsx" | "pptx",
      password?: string
    ) => {
      if (!doc) return;
      setIsDownloading(true);
      setError(null);
      try {
        const body: Record<string, unknown> = { udm: doc };
        // Encrypt-on-export only meaningful for /api/export (PDF).
        if (password && endpoint === "/api/export") {
          body.password = password;
        }
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // Anonymous telemetry event: just the route + status. We
          // deliberately do NOT include the server's error message
          // body — it may contain document-data fragments.
          track("export_failed", {
            route: endpoint,
            status: res.status,
            mode: doc?.mode,
          });
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
        // Network or client-side error (TypeError, etc.) — log the
        // class name only, never the message body.
        if (e instanceof Error && e.name && e.name !== "Error") {
          track("export_threw", {
            route: endpoint,
            error_class: e.name,
            mode: doc?.mode,
          });
        }
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
  const handleDownloadMd = useCallback(
    () => downloadExport("/api/export-md", "md"),
    [downloadExport]
  );
  const handleDownloadHtml = useCallback(
    () => downloadExport("/api/export-html", "html"),
    [downloadExport]
  );
  const handleDownloadEpub = useCallback(
    () => downloadExport("/api/export-epub", "epub"),
    [downloadExport]
  );
  const handleDownloadXlsx = useCallback(
    () => downloadExport("/api/export-xlsx", "xlsx"),
    [downloadExport]
  );
  const handleDownloadPptx = useCallback(
    () => downloadExport("/api/export-pptx", "pptx"),
    [downloadExport]
  );

  const resetToSynthetic = useCallback(() => {
    setSrc(DEFAULT_SRC);
    setMeta(null);
    setIsEditing(false);
  }, []);

  const canEdit =
    doc?.mode === "flow" ||
    doc?.mode === "fixed" ||
    doc?.mode === "sheet" ||
    doc?.mode === "slides";
  const showDownload =
    doc !== null &&
    (doc.mode === "fixed" ||
      doc.mode === "flow" ||
      doc.mode === "sheet" ||
      doc.mode === "slides");
  // Only surface our top-level undo/redo for fixed mode — flow has
  // TipTap's own undo on its toolbar.
  const showHistoryControls = isEditing && doc?.mode === "fixed";

  // Full "at a glance" details for the middle of the session box — this
  // is the old standalone DocumentSummary box, relocated here so the
  // stretch space carries real info instead of a void. Filename is
  // deliberately omitted: it already lives in the info row above.
  const glance = (() => {
    if (!doc) return null;
    const content = doc.content as unknown as Record<string, unknown>;
    const len = (k: string) =>
      Array.isArray(content[k]) ? (content[k] as unknown[]).length : 0;
    let n = len("pages");
    let unit = "pages";
    if (doc.mode === "slides") (n = len("slides")), (unit = "slides");
    else if (doc.mode === "sheet") (n = len("sheets")), (unit = "sheets");
    else if (doc.mode === "flow") (n = len("blocks")), (unit = "blocks");
    const mime = doc.metadata.source_format?.mime ?? "";
    return {
      n,
      unit,
      images: doc.resources.images.length,
      fonts: doc.resources.fonts.length,
      subsets: doc.resources.fonts.filter((f) => f._meta?.subset).length,
      mode: doc.mode,
      source: mime.split("/").pop() || mime || "—",
      udm: String(doc.udm_version ?? "—"),
      producer: doc.metadata.source_format?.producer ?? null,
    };
  })();

  return (
    <div className="space-y-6">
      {/* Import box + the session/actions box sit side by side on
          desktop (stack on mobile). items-stretch makes them equal
          height; the compacted dropzone centers its content so they
          read as a balanced pair rather than a tall box next to a
          short one. */}
      <div className="grid lg:grid-cols-2 gap-6 items-stretch">
      <UploadZone onUploaded={handleUploaded} />

      <div className="border border-border bg-surface flex flex-col h-full">
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
              {(meta.size / 1024).toFixed(1)}KB
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

        {/* Middle: the document's full at-a-glance details (relocated
            from the old standalone summary box). flex-1 fills the
            stretch space so the box reads as header / body / footer. */}
        <div className="flex-1 flex items-center px-4 py-5">
          {glance ? (
            <dl className="w-full grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
              <GlanceField label={glance.unit} value={String(glance.n)} />
              <GlanceField label="images" value={String(glance.images)} />
              <GlanceField label="mode" value={glance.mode} accent />
              <GlanceField label="source" value={glance.source} />
              <GlanceField
                label="fonts"
                value={`${glance.fonts}${glance.subsets ? ` · ${glance.subsets} subset` : ""}`}
              />
              <GlanceField label="udm" value={glance.udm} />
              {glance.producer && (
                <GlanceField label="producer" value={glance.producer} span2 />
              )}
            </dl>
          ) : (
            <div className="w-full text-center font-mono text-[0.65rem] uppercase tracking-wider text-subtle">
              drop a file on the left to begin
            </div>
          )}
        </div>

        {/* Actions pinned to the bottom (border-t = footer divider). */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-border">
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
              {(doc?.mode === "fixed" || doc?.mode === "flow") && (
                <>
                  <button
                    onClick={handleDownloadPdf}
                    disabled={isDownloading}
                    className="btn-primary"
                  >
                    {isDownloading ? "exporting…" : "↓ pdf"}
                  </button>
                  <button
                    onClick={() => setExportPasswordOpen(true)}
                    disabled={isDownloading}
                    className="btn-ghost"
                    title="Download as PDF with a password"
                  >
                    🔒 pdf
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
              {/* MD / HTML / EPUB exports only apply to flow mode;
                  the text-adapter exporters reject fixed UDM. */}
              {doc?.mode === "flow" && (
                <>
                  <button
                    onClick={handleDownloadMd}
                    disabled={isDownloading}
                    className="btn-ghost"
                  >
                    ↓ md
                  </button>
                  <button
                    onClick={handleDownloadHtml}
                    disabled={isDownloading}
                    className="btn-ghost"
                  >
                    ↓ html
                  </button>
                  <button
                    onClick={handleDownloadEpub}
                    disabled={isDownloading}
                    className="btn-ghost"
                  >
                    ↓ epub
                  </button>
                </>
              )}
              {doc?.mode === "sheet" && (
                <button
                  onClick={handleDownloadXlsx}
                  disabled={isDownloading}
                  className="btn-primary"
                >
                  {isDownloading ? "exporting…" : "↓ xlsx"}
                </button>
              )}
              {doc?.mode === "slides" && (
                <button
                  onClick={handleDownloadPptx}
                  disabled={isDownloading}
                  className="btn-primary"
                >
                  {isDownloading ? "exporting…" : "↓ pptx"}
                </button>
              )}
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
            <FontFaceStyles resources={draft.state.resources} />            <FixedEditor doc={draft.state} onChange={handleEditedDoc} />
          </div>
        ) : isEditing && doc.mode === "sheet" ? (
          <div className="space-y-4">            <SheetEditor
              content={draft.state.content as SheetContent}
              onChange={(content) =>
                handleEditedDoc({ ...draft.state, content } as Document)
              }
            />
          </div>
        ) : isEditing && doc.mode === "slides" ? (
          <div className="space-y-4">            <SlideEditor
              content={draft.state.content as SlidesContent}
              resources={draft.state.resources}
              onChange={(content) =>
                handleEditedDoc({ ...draft.state, content } as Document)
              }
            />
          </div>
        ) : (
          <UdmViewer doc={doc} />
        )
      )}

      <ExportPasswordModal
        open={exportPasswordOpen}
        onClose={() => setExportPasswordOpen(false)}
        onConfirm={async (pw) => {
          await downloadExport("/api/export", "pdf", pw || undefined);
          setExportPasswordOpen(false);
        }}
        sourceHadPassword={!!meta?.had_password}
        isExporting={isDownloading}
      />

      <ReportProblemModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        doc={isEditing ? draft.state : doc}
        sourceUrl={
          meta
            ? `/uploads/${meta.session_id}/source.${
                meta.format === "image"
                  ? (meta.filename.toLowerCase().split(".").pop() || "png")
                  : meta.format
              }`
            : null
        }
        sourceFilename={meta?.filename ?? null}
        sessionId={meta?.session_id ?? null}
      />
    </div>
  );
}
