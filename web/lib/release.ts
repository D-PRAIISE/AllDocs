/**
 * The current release's news, and the rules for when to announce it.
 *
 * Two surfaces share this: the strip under the site header, and the
 * popup a visitor gets on the first page they land on. Keeping the copy
 * and the dates in one place means they can never disagree about what
 * shipped or about when to stop saying so.
 *
 * Shipping the next release is this file alone — bump both constants and
 * replace ITEMS. Both surfaces come back on their own, because a
 * returning visitor's stored flag no longer matches RELEASE_ID.
 */

export const RELEASE_ID = "2026-11-07";

/** Seven days: the release day and the six after it. Both surfaces stop
 *  rendering at the start of the 14th whatever is in storage, so a
 *  release note cannot outlive its own news. */
export const RELEASE_UNTIL = Date.parse("2026-11-14T00:00:00Z");

/** Survives the browser closing: "this visitor has seen this release". */
export const SEEN_KEY = "alldocs_whatsnew_seen";

/** Dies with the tab: "this visit has already had its popup". This is
 *  what makes the popup a landing-page event rather than something that
 *  reappears every time someone clicks through to another page. */
export const VISIT_KEY = "alldocs_whatsnew_visit";

export const HEADLINE =
  "Truer watermarks, sharper text, and an editor that fits a phone.";

export interface ReleaseItem {
  title: string;
  body: string;
}

/** Written for the person using the editor, not from the commit log:
 *  what they will notice, in the words they would use for it. */
export const ITEMS: ReadonlyArray<ReleaseItem> = [
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

/** Still news? */
export function releaseIsCurrent(): boolean {
  return Date.now() <= RELEASE_UNTIL;
}

/** Has this visitor already dismissed *this* release? Storage can throw
 *  in private mode, and a visitor we cannot remember is better served by
 *  being told again than by being silently skipped. */
export function releaseDismissed(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === RELEASE_ID;
  } catch {
    return false;
  }
}

/** Fired when any surface is dismissed, so the others can go at once.
 *  Without it, closing the popup leaves the strip sitting behind it
 *  repeating news the visitor has just told us they have read — the
 *  strip only re-reads storage on mount. */
export const SEEN_EVENT = "alldocs:release-seen";

export function markReleaseSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, RELEASE_ID);
  } catch {
    /* private mode — it will come back next visit, which is acceptable */
  }
  try {
    window.dispatchEvent(new Event(SEEN_EVENT));
  } catch {
    /* no window (never, in a client component) — nothing to notify */
  }
}

/**
 * True only on the first page of a visit.
 *
 * Called once per mount. The first call in a tab finds nothing and
 * claims the marker; every later page in that tab — whether a client-side
 * route change or a fresh document load — finds it already set. That is
 * what keeps the popup to the page someone actually arrived on, rather
 * than firing again each time they click through the site.
 *
 * Not idempotent by design: the caller must ask exactly once.
 */
export function claimFirstPageOfVisit(): boolean {
  try {
    if (sessionStorage.getItem(VISIT_KEY)) return false;
    sessionStorage.setItem(VISIT_KEY, "1");
    return true;
  } catch {
    // No sessionStorage: treat every load as an arrival rather than
    // never showing it. An extra popup beats a silent one.
    return true;
  }
}
