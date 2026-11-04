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
 * into the space actually available. Capped at 1 so "fit" never upscales
 * a page that already fits. Returns 1 during SSR.
 *
 * Pass the scroll container when you have one. Guessing the gutters from
 * `innerWidth` is what made the editor scroll sideways on every phone:
 * the guess reserved 48px while the real chain is 82px — the page shell's
 * `px-6` (48) plus the canvas container's `p-4` (32) plus its 1px borders
 * — so every page rendered 34px wider than the space it had. Measuring
 * the element can't drift when someone changes a padding class.
 */
export function fitScaleForWidth(
  pageWidthPx: number,
  container?: HTMLElement | null
): number {
  if (typeof window === "undefined" || pageWidthPx <= 0) return 1;
  let avail: number;
  if (container) {
    // clientWidth excludes borders and scrollbar but still includes the
    // element's own padding, so take that back off.
    const cs = window.getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    avail = container.clientWidth - padX;
  } else {
    avail = window.innerWidth - 82;
  }
  const s = (avail - 2) / pageWidthPx; // 2px of breathing room
  return Math.max(0.1, Math.min(1, Math.round(s * 100) / 100));
}
