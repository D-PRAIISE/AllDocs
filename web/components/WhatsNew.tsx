"use client";

import { useEffect, useState } from "react";

/**
 * "What's new" strip, shown under the site header for a week after a
 * release so returning users find out what changed without being sent
 * to a changelog they'd never open.
 *
 * Two independent stops, because either alone is wrong:
 *
 *   - RELEASE_UNTIL is a hard date. Whatever a visitor has in storage,
 *     the strip stops rendering after it — a release note can't outlive
 *     its own news just because nobody got round to deleting it.
 *   - the dismissal is keyed to RELEASE_ID, so closing it hides *this*
 *     release only. The next one gets its own week, with no stale flag
 *     suppressing it.
 *
 * To ship the next one: bump both constants and replace the copy. The
 * old flag in a returning visitor's storage no longer matches, so the
 * strip comes back on its own.
 */

const RELEASE_ID = "2026-11-07";
/** Seven days: the release day and the six after it. The strip stops
 *  rendering at the start of the 14th. */
const RELEASE_UNTIL = Date.parse("2026-11-14T00:00:00Z");
const STORAGE_KEY = "alldocs_whatsnew_seen";

const HEADLINE = "Truer watermarks, sharper text, and an editor that fits a phone.";

/** Written for the person using the editor, not from the commit log:
 *  what they'll notice, in the words they'd use for it. */
const ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Watermarks and logos keep their transparency",
    body:
      "A faded stamp used to import as a solid block sitting over your text. It now keeps its transparency the whole way through — import, edit and export — and you can set any image's opacity in the editor.",
  },
  {
    title: "Click a line, get the line",
    body:
      "Clicking text used to select a single word, or part of one, because of how the original file stored it. Lines now open as one piece you can edit straight through.",
  },
  {
    title: "Text keeps the width it had in the original",
    body:
      "No more words running into each other or splitting apart where the original used a different font — in the editor and in the file you download.",
  },
  {
    title: "Underline",
    body: "Alongside bold and italic in the format bar, and it survives export.",
  },
  {
    title: "Deleting mid-line text offers to close the gap",
    body:
      "Take a word out of the middle of a line and AllDocs offers to pull the rest of the line in behind it, instead of leaving a hole you can't close.",
  },
  {
    title: "A mobile editor made for a phone",
    body:
      "The format bar sits above the keyboard instead of over the words you're typing, pages no longer scroll sideways, and the type and controls are sized for a phone rather than shrunk from a desktop.",
  },
];

export function WhatsNew() {
  // Starts hidden so the server and the first client render agree;
  // the effect decides on mount, once localStorage is readable.
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (Date.now() > RELEASE_UNTIL) return;
    try {
      setShow(localStorage.getItem(STORAGE_KEY) !== RELEASE_ID);
    } catch {
      // Private mode or storage disabled. Still show it — the strip is
      // dismissible per visit, which is better than never appearing.
      setShow(true);
    }
  }, []);

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(STORAGE_KEY, RELEASE_ID);
    } catch {
      /* nothing to persist to — it'll come back next visit, which is fine */
    }
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
