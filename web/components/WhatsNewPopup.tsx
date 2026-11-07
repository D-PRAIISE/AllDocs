"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { EditorPreviewMotion } from "./EditorPreviewMotion";
import {
  HEADLINE,
  ITEMS,
  claimFirstPageOfVisit,
  markReleaseSeen,
  releaseDismissed,
  releaseIsCurrent,
} from "@/lib/release";

/**
 * The release news as a popup, shown once on the page a visitor
 * actually arrives on.
 *
 * Four conditions, all of which must hold:
 *
 *   1. the release is still current (lib/release's hard date);
 *   2. this visitor has not already dismissed it;
 *   3. this is the first page of the visit — not somewhere they clicked
 *      through to. Someone browsing the site should not be interrupted
 *      again on every page;
 *   4. the hero is not already playing it. On the desktop home page the
 *      same motion graphic is sitting right there in the hero, so a
 *      popup over the top of it would be showing someone a thing twice.
 *      Below the `sm` breakpoint the hero mock is hidden, so the home
 *      page *does* get the popup on a phone.
 *
 * (3) is why someone landing straight on /edit or a format page — which
 * is how most search traffic arrives — still gets told what changed.
 */
export function WhatsNewPopup() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!releaseIsCurrent() || releaseDismissed()) return;

    // Must be asked exactly once per mount, and it is the ask itself
    // that claims the visit — so check the cheap conditions first.
    if (!claimFirstPageOfVisit()) return;

    // Matches the `hidden sm:block` that gates the hero mock, rather
    // than the app's own mobile breakpoint (768px) — what matters here
    // is whether the illustration is actually on screen behind us.
    const heroIsPlayingIt =
      pathname === "/" && window.matchMedia("(min-width: 640px)").matches;
    if (heroIsPlayingIt) return;

    setShow(true);
    // Only asked once per visit, so pathname changes must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    markReleaseSeen();
  }, []);

  // Escape closes, and the page behind must not scroll under the scrim.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [show, dismiss]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whatsnew-popup-title"
    >
      {/* Scrim. Clicking it closes, the same as the button — a modal you
          can't dismiss by clicking away from is a trap. */}
      <button
        type="button"
        aria-label="Dismiss what's new"
        tabIndex={-1}
        onClick={dismiss}
        className="absolute inset-0 bg-black/75 cursor-default"
      />

      {/* Column, not one scrolling box. The panel is taller than a
          short laptop viewport, and when the whole thing scrolled the
          title and the dismiss button both left the screen — the two
          things a modal must never take away. */}
      <div className="relative w-full max-w-[560px] max-h-[92vh] flex flex-col border border-border bg-surface shadow-2xl">
        <div className="shrink-0 flex items-start gap-3 border-b border-border px-4 py-3">
          <span className="font-mono text-[0.6rem] uppercase tracking-wider text-accent border border-accent px-1.5 py-0.5 shrink-0 mt-0.5">
            new
          </span>
          <p
            id="whatsnew-popup-title"
            className="font-sans text-sm text-fg leading-snug flex-1 min-w-0"
          >
            {HEADLINE}
          </p>
          <button
            ref={closeRef}
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="font-mono text-base text-muted hover:text-fg transition-colors shrink-0 w-7 h-7 flex items-center justify-center -mt-0.5"
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto">
          <div className="p-3 sm:p-4">
            <EditorPreviewMotion />
          </div>

        {/* Titles only. The animation carries the detail; a wall of
            prose under it would just be the strip again, and the panel
            has to stay inside 92vh on a phone. */}
        <ul className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
          {ITEMS.map((item) => (
            <li
              key={item.title}
              className="font-mono text-[0.6rem] uppercase tracking-wider text-fg/70 leading-relaxed"
            >
              <span className="text-accent">·</span> {item.title}
            </li>
          ))}
        </ul>

        </div>

        <div className="shrink-0 flex justify-end border-t border-border px-4 py-3">
          <button type="button" onClick={dismiss} className="btn-primary">
            got it
          </button>
        </div>
      </div>
    </div>
  );
}
