"use client";

import { useEffect, useRef, useState } from "react";

import type { Document } from "@/lib/udm";

interface ReportProblemModalProps {
  open: boolean;
  onClose: () => void;
  // The currently-open document's UDM (sent so we know the editor's
  // working state when the bug happened).
  doc: Document | null;
  // URL of the original uploaded file, if any. We fetch the bytes
  // here so the user doesn't have to re-pick.
  sourceUrl: string | null;
  sourceFilename: string | null;
  sessionId: string | null;
}

interface ReportResponse {
  ticket_id: string;
  received_at: string;
}

export function ReportProblemModal({
  open,
  onClose,
  doc,
  sourceUrl,
  sourceFilename,
  sessionId,
}: ReportProblemModalProps) {
  const [description, setDescription] = useState("");
  const [includeSource, setIncludeSource] = useState(true);
  const [includeUdm, setIncludeUdm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ReportResponse | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the description box when the modal opens; reset state when
  // it closes so a re-open starts clean.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccess(null);
    queueMicrotask(() => textareaRef.current?.focus());
  }, [open]);

  // Esc closes (unless we're submitting — let the network finish).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("description", description.trim());
      if (sessionId) fd.append("session_id", sessionId);
      if (typeof navigator !== "undefined") {
        fd.append("user_agent", navigator.userAgent);
      }
      if (includeUdm && doc) {
        fd.append("udm", JSON.stringify(doc));
      }
      if (includeSource && sourceUrl) {
        try {
          const blob = await (await fetch(sourceUrl)).blob();
          const name = sourceFilename || "source.pdf";
          fd.append("source", blob, name);
        } catch {
          // If the source can't be fetched, send the report without
          // it — better partial than nothing.
        }
      }
      const res = await fetch("/api/report", { method: "POST", body: fd });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ReportResponse;
      setSuccess(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2
            id="report-modal-title"
            className="font-mono text-sm uppercase tracking-wider text-fg"
          >
            report a problem
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="font-mono text-sm text-muted hover:text-fg disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {success ? (
          <div className="px-4 py-6 space-y-3">
            <div className="font-mono text-xs uppercase tracking-wider text-success">
              report received
            </div>
            <div className="font-mono text-xs text-fg break-all">
              ticket id: <span className="text-accent">{success.ticket_id}</span>
            </div>
            <div className="font-mono text-xs text-muted">
              Thanks. We'll look at the attached document, fix what we
              can, and reference this ID if we follow up.
            </div>
            <button onClick={onClose} className="btn-ghost">
              done
            </button>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-3">
            <label className="block">
              <span className="label">what went wrong?</span>
              <textarea
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder={
                  "Describe what you tried to do and what happened instead. " +
                  "The more specific, the faster we can fix it."
                }
                className="mt-1 w-full px-3 py-2 bg-input border border-border text-fg font-sans text-sm resize-y"
                style={{ color: "#111", caretColor: "#111", background: "#fff" }}
              />
            </label>

            <fieldset className="space-y-1.5 pt-1">
              <legend className="label">attach (helps us reproduce)</legend>
              <label className="flex items-center gap-2 font-mono text-xs text-fg">
                <input
                  type="checkbox"
                  checked={includeSource}
                  onChange={(e) => setIncludeSource(e.target.checked)}
                  disabled={!sourceUrl}
                />
                <span>
                  the original{" "}
                  <span className="text-subtle">
                    {sourceFilename
                      ? `(${sourceFilename})`
                      : sourceUrl
                      ? "(uploaded file)"
                      : "(none — using synthetic fixture)"}
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 font-mono text-xs text-fg">
                <input
                  type="checkbox"
                  checked={includeUdm}
                  onChange={(e) => setIncludeUdm(e.target.checked)}
                  disabled={!doc}
                />
                <span>
                  your current edits{" "}
                  <span className="text-subtle">(in-progress UDM state)</span>
                </span>
              </label>
            </fieldset>

            <div className="font-mono text-[0.65rem] text-subtle leading-relaxed border-t border-border pt-3">
              We use these attachments only to fix the bug you're
              reporting. They're never used for training. Tickets are
              deleted within 30 days of resolution. By submitting you
              agree to share the attached document for that purpose.
            </div>

            {error && (
              <div className="border border-error/40 bg-error/10 px-3 py-2 font-mono text-xs text-error">
                {error}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || description.trim().length === 0}
                className="btn-primary"
              >
                {submitting ? "sending…" : "send report"}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="btn-ghost"
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
