"use client";

import { useEffect, useState } from "react";

// Below this viewport width we treat the session as "mobile": the
// canvas editor is a desktop mouse experience, so on phones we fit
// pages to the screen, make the toolbar scroll, and steer precise
// editing toward desktop.
export const MOBILE_MAX_PX = 768;

/** True when the viewport is phone-sized. SSR-safe: starts false, then
 *  resolves on mount and tracks resizes/orientation changes. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_PX - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}

/**
 * Height in CSS pixels currently hidden by the on-screen keyboard (0 when
 * it's closed, or on any browser without visualViewport).
 *
 * iOS doesn't shrink the layout viewport when the keyboard opens — it
 * shrinks the *visual* viewport and scrolls it — so `100vh`, `innerHeight`
 * and `position: fixed; bottom: 0` all still resolve to a point behind the
 * keyboard. Reading visualViewport is the only way to find the real usable
 * bottom edge, which is what anything docked above the keyboard needs.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      // Layout height minus what's visible and minus how far the visual
      // viewport has been scrolled up = what the keyboard is covering.
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    };
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, []);
  return inset;
}

/**
 * Scale that fits a page of the given pixel width (at 96 DPI / scale 1)
 * into the current viewport, leaving room for the page padding and
 * container gutters. Capped at 1 so "fit" never upscales a page that
 * already fits. Returns 1 during SSR.
 */
export function fitScaleForWidth(pageWidthPx: number): number {
  if (typeof window === "undefined" || pageWidthPx <= 0) return 1;
  const avail = window.innerWidth - 48; // ~page padding + container gutters
  const s = avail / pageWidthPx;
  return Math.max(0.1, Math.min(1, Math.round(s * 100) / 100));
}
