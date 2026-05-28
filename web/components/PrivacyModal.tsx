"use client";

import { useEffect, useState } from "react";

import {
  getTelemetryConsent,
  setTelemetryConsent,
  type TelemetryConsent,
} from "@/lib/telemetry";

interface PrivacyModalProps {
  open: boolean;
  onClose: () => void;
}

export function PrivacyModal({ open, onClose }: PrivacyModalProps) {
  const [consent, setConsent] = useState<TelemetryConsent>("off");

  useEffect(() => {
    if (!open) return;
    setConsent(getTelemetryConsent());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const flip = () => {
    const next: TelemetryConsent = consent === "on" ? "off" : "on";
    setTelemetryConsent(next);
    setConsent(next);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2
            id="privacy-modal-title"
            className="font-mono text-sm uppercase tracking-wider text-fg"
          >
            privacy &amp; data
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="font-mono text-sm text-muted hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <section className="space-y-2">
            <div className="label">what we store</div>
            <ul className="font-mono text-xs text-fg space-y-1.5 leading-relaxed">
              <li>
                <span className="text-accent">uploads</span> · auto-deleted
                after <span className="text-fg">24 hours</span>
              </li>
              <li>
                <span className="text-accent">bug-report tickets</span> ·
                kept until the bug is closed, then{" "}
                <span className="text-fg">30 days</span>
              </li>
              <li>
                <span className="text-accent">audit log</span> · hashed IPs
                only, never document content
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <div className="label">what we never do</div>
            <ul className="font-mono text-xs text-fg space-y-1.5 leading-relaxed">
              <li>never train ML on your documents</li>
              <li>never share or sell user data</li>
              <li>no signups, no tracking cookies, no third-party analytics</li>
            </ul>
          </section>

          <section className="space-y-2 border-t border-border pt-4">
            <div className="label">anonymous error reports (opt-in)</div>
            <p className="font-mono text-xs text-muted leading-relaxed">
              If on, AllDocs sends event types when an API call fails —
              the route, the HTTP status, and the JavaScript error
              class. Never the document content, never the file name,
              never the error message body.
            </p>
            <button
              type="button"
              onClick={flip}
              className={`font-mono text-xs px-3 py-1.5 border transition-colors ${
                consent === "on"
                  ? "bg-accent text-accent-fg border-accent"
                  : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
              }`}
              aria-pressed={consent === "on"}
            >
              {consent === "on" ? "✓ on — sending anonymous events" : "○ off — sending nothing"}
            </button>
          </section>

          <div className="font-mono text-[0.65rem] text-subtle border-t border-border pt-3 leading-relaxed">
            Full details in{" "}
            <a
              href="https://github.com/D-PRAIISE/AllDocs/blob/main/docs/PRIVACY.md"
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-fg underline-offset-4 hover:underline"
            >
              docs/PRIVACY.md
            </a>
            . AllDocs is open source — you can audit how data is
            handled.
          </div>
        </div>
      </div>
    </div>
  );
}
