"use client";

import { useEffect, useState } from "react";

import {
  HEADLINE,
  ITEMS,
  SEEN_EVENT,
  markReleaseSeen,
  releaseDismissed,
  releaseIsCurrent,
} from "@/lib/release";

/**
 * "What's new" strip, shown under the site header for a week after a
 * release so returning users find out what changed without being sent
 * to a changelog they'd never open.
 *
 * The dates, the copy and the storage rules live in lib/release, shared
 * with the first-visit popup so the two can never disagree about what
 * shipped or about when to stop saying so. Dismissing either surface
 * dismisses the release.
 */
export function WhatsNew() {
  // Starts hidden so the server and the first client render agree;
  // the effect decides on mount, once localStorage is readable.
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!releaseIsCurrent()) return;
    setShow(!releaseDismissed());
    // The popup can dismiss the release out from under us on the very
    // page we are rendering on. Go with it rather than sitting there
    // repeating what they just closed.
    const gone = () => setShow(false);
    window.addEventListener(SEEN_EVENT, gone);
    return () => window.removeEventListener(SEEN_EVENT, gone);
  }, []);

  const dismiss = () => {
    setShow(false);
    markReleaseSeen();
  };

  if (!show) return null;

  return (
    <aside
      aria-label="What's new in AllDocs"
      className="border-b border-border bg-elevated"
    >
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-10 py-2 sm:py-2.5">
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="font-mono text-[0.6rem] sm:text-[0.65rem] uppercase tracking-wider text-accent border border-accent px-1.5 py-0.5 shrink-0">
            new
          </span>
          {/* Wraps rather than truncates. At 390px this headline runs to
              two lines, and half a clipped sentence tells a visitor
              nothing — the extra 16px is the cheaper trade. */}
          <p className="font-sans text-xs sm:text-sm text-fg/90 leading-snug min-w-0 flex-1">
            {HEADLINE}
          </p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="font-mono text-[0.6rem] sm:text-xs uppercase tracking-wider text-muted hover:text-fg transition-colors shrink-0"
          >
            {open ? (
              "hide"
            ) : (
              <>
                {/* "what changed" costs ~85px of a 390px row, which is
                    what pushed the headline into being clipped. */}
                <span className="sm:hidden">details</span>
                <span className="hidden sm:inline">what changed</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss what's new"
            className="font-mono text-sm text-muted hover:text-fg transition-colors shrink-0 w-6 h-6 flex items-center justify-center"
          >
            &times;
          </button>
        </div>

        {open && (
          /* Six items stack to ~717px on a phone, which buries the page
             under the strip. Cap it and let the list scroll inside
             itself; on a wide screen the two-column grid fits anyway. */
          <ul className="mt-3 mb-1 grid grid-cols-1 lg:grid-cols-2 gap-px bg-border border border-border max-h-[55vh] overflow-y-auto sm:max-h-none sm:overflow-visible">
            {ITEMS.map((item) => (
              <li key={item.title} className="bg-surface p-3 sm:p-4">
                <div className="font-mono text-[0.65rem] sm:text-xs uppercase tracking-wider text-accent">
                  {item.title}
                </div>
                <p className="mt-1.5 font-sans text-xs sm:text-sm text-fg/80 leading-relaxed">
                  {item.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
