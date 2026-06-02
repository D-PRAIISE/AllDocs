"use client";

import { useEffect } from "react";

/** Fires a single /api/stats/visit ping per browser session per page
 * type. Deduped via sessionStorage so reloads + client-side nav don't
 * inflate the count. No cookies, no persistent ID — sessionStorage is
 * cleared when the tab closes. */
export function PageViewBeacon({ page }: { page: "landing" | "editor" }) {
  useEffect(() => {
    const key = `alldocs-visit-${page}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // sessionStorage unavailable (private mode etc.) — still send the
      // beacon once per mount; minor over-count is acceptable.
    }
    void fetch("/api/stats/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page }),
      keepalive: true,
    }).catch(() => {});
  }, [page]);

  return null;
}
