"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";
const STORAGE_KEY = "alldocs-theme";

/** Tiny header control: persists choice in localStorage; falls back to
 * the OS preference on first load so a returning user gets what they
 * picked and a new one gets what their system already says. */
export function ThemeToggle() {
  // Default to dark; the real value gets applied on mount once we can
  // read localStorage / matchMedia (SSR doesn't have either).
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let initial: Theme = "dark";
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        initial = stored;
      } else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        initial = "light";
      }
    } catch {
      // Private mode, embedded, etc. — fall through to dark.
    }
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore quota / disabled storage.
    }
  };

  // Render a stable placeholder during SSR so hydration doesn't flicker.
  if (!mounted) {
    return (
      <button
        type="button"
        className="font-mono text-[0.65rem] uppercase tracking-wider text-subtle px-2 py-1 border border-border"
        aria-label="Theme toggle"
        suppressHydrationWarning
      >
        ◐
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={flip}
      className="font-mono text-[0.65rem] uppercase tracking-wider text-muted hover:text-fg px-2 py-1 border border-border hover:border-fg transition-colors"
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "☀ light" : "☾ dark"}
    </button>
  );
}
