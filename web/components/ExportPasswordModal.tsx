"use client";

import { useEffect, useRef, useState } from "react";

interface ExportPasswordModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (password: string) => void;
  /** True if the source PDF was opened with a password — used to
   * surface a hint in the modal but never to preserve the actual
   * password (we don't store it). */
  sourceHadPassword: boolean;
  isExporting: boolean;
}

export function ExportPasswordModal({
  open,
  onClose,
  onConfirm,
  sourceHadPassword,
  isExporting,
}: ExportPasswordModalProps) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showMismatch, setShowMismatch] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPw("");
    setConfirm("");
    setShowMismatch(false);
    queueMicrotask(() => ref.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isExporting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isExporting, onClose]);

  if (!open) return null;

  const handleSubmit = () => {
    if (pw && pw !== confirm) {
      setShowMismatch(true);
      return;
    }
    onConfirm(pw);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-password-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isExporting) onClose();
      }}
    >
      <div className="w-full max-w-md border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2
            id="export-password-title"
            className="font-mono text-sm uppercase tracking-wider text-fg"
          >
            download as pdf
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            aria-label="Close"
            className="font-mono text-sm text-muted hover:text-fg disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          {sourceHadPassword ? (
            <div className="font-mono text-[0.7rem] text-warn leading-relaxed">
              The original PDF was password-protected. AllDocs does not
              remember your password — re-enter it below to keep the
              same protection, set a different one, or leave blank to
              download unprotected.
            </div>
          ) : (
            <div className="font-mono text-[0.7rem] text-muted leading-relaxed">
              Optional: protect this PDF with a password. Leave blank
              to download unprotected.
            </div>
          )}

          <label className="block space-y-1">
            <span className="label">password (optional)</span>
            <input
              ref={ref}
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setShowMismatch(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              placeholder="leave blank for no password"
              className="w-full px-3 py-2 border border-border bg-input font-mono text-sm"
              style={{ color: "#111", caretColor: "#111", background: "#fff" }}
              autoComplete="new-password"
            />
          </label>

          {pw && (
            <label className="block space-y-1">
              <span className="label">confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setShowMismatch(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
                className="w-full px-3 py-2 border border-border bg-input font-mono text-sm"
                style={{ color: "#111", caretColor: "#111", background: "#fff" }}
                autoComplete="new-password"
              />
            </label>
          )}

          {showMismatch && (
            <div className="font-mono text-xs text-error">
              passwords don&apos;t match
            </div>
          )}

          <div className="font-mono text-[0.6rem] text-subtle leading-relaxed pt-1">
            Encryption: AES-256 (PDF 2.0). Anyone with the password can
            open and edit the file. AllDocs never sees or stores your
            password after the download completes.
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isExporting}
              className="btn-primary"
            >
              {isExporting
                ? "exporting…"
                : pw
                ? "↓ encrypted pdf"
                : "↓ pdf (no password)"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isExporting}
              className="btn-ghost"
            >
              cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
