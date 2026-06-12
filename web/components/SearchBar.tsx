"use client";

import { useEffect, useRef } from "react";

/**
 * Compact find-in-document bar. Renders above the page container; the
 * actual match highlighting is drawn by each view (DOM overlay in the
 * read-only viewer, canvas rect in the editor). Shared by both.
 */
export function SearchBar({
  query,
  onQueryChange,
  totalMatches,
  activeIdx,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  totalMatches: number;
  activeIdx: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const btn =
    "font-mono text-xs px-2 py-1 border border-border text-muted hover:text-fg hover:border-fg disabled:opacity-25 disabled:hover:text-muted disabled:hover:border-border";
  return (
    <div className="border border-border bg-surface px-3 py-2 flex items-center gap-2">
      <span className="label">find</span>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="search text…"
        // text-fg + bg-bg adapt to the theme — no hardcoded colour, so
        // the text stays visible in both dark and light mode.
        className="font-mono text-xs px-2 py-1 bg-bg border border-border text-fg caret-fg flex-1 min-w-0"
      />
      <span className="font-mono text-[0.65rem] uppercase tracking-wider text-subtle whitespace-nowrap">
        {totalMatches === 0
          ? query.trim() === ""
            ? "—"
            : "0 matches"
          : `${activeIdx + 1} / ${totalMatches}`}
      </span>
      <button
        className={btn}
        onClick={onPrev}
        disabled={totalMatches === 0}
        title="Previous (Shift+Enter)"
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        className={btn}
        onClick={onNext}
        disabled={totalMatches === 0}
        title="Next (Enter)"
        aria-label="Next match"
      >
        ↓
      </button>
      <button className={btn} onClick={onClose} title="Close (Esc)" aria-label="Close search">
        ✕
      </button>
    </div>
  );
}
