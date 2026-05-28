/**
 * Opt-in anonymous client telemetry.
 *
 * Off by default. The user has to flip the toggle in the privacy
 * modal for any of this to actually fire. Every `track()` call is a
 * no-op unless localStorage carries the consent flag.
 *
 * Data shape (see /api/telemetry):
 *   { event: <lowercase identifier>, props: { ...primitives } }
 *
 * Strict rules for what's allowed in props:
 *   - No document content
 *   - No filenames
 *   - No full error message bodies (an attacker-controlled string
 *     could embed user data). Use the error CLASS + a short stable
 *     code we control.
 *   - No session IDs or URLs with session IDs (use the route shape
 *     instead, e.g. "/api/export-pdf" not "/uploads/abc-123/...")
 */

const STORAGE_KEY = "alldocs-telemetry";

export type TelemetryConsent = "on" | "off";

export function getTelemetryConsent(): TelemetryConsent {
  if (typeof window === "undefined") return "off";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export function setTelemetryConsent(value: TelemetryConsent): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private mode / storage disabled — silently ignore.
  }
}

export interface TrackProps {
  // Stable identifier (NOT the raw error message body).
  error_code?: string;
  // Where it happened.
  route?: string;
  // HTTP status if known.
  status?: number;
  // Error class name, e.g. "TypeError" — never the message body.
  error_class?: string;
  // Mode of the document at the time, when relevant.
  mode?: string;
}

/** Send an event to the telemetry endpoint. No-op unless consent
 * is "on". Best-effort — the call is fire-and-forget; failure is
 * swallowed (we won't ever block a user action on telemetry). */
export function track(event: string, props: TrackProps = {}): void {
  if (typeof window === "undefined") return;
  if (getTelemetryConsent() !== "on") return;
  // Don't await — telemetry must never delay a user action. The
  // catch swallows network errors; "failed to send error report"
  // shouldn't itself become a noisy error.
  void fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, props }),
    keepalive: true,
  }).catch(() => {});
}
