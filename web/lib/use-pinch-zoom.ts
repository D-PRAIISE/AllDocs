"use client";

import { useEffect, useRef, type RefObject } from "react";

const clamp = (s: number) => Math.max(0.1, Math.min(4, Math.round(s * 100) / 100));

/**
 * Two-finger pinch-to-zoom over a scroll container, mapped onto the
 * document's own `scale` (not the browser viewport).
 *
 * The element should set `touch-action: pan-x pan-y` so one finger
 * still scrolls natively while the browser leaves pinch gestures to us.
 * We attach a non-passive `touchmove` listener so we can preventDefault
 * mid-pinch (React's synthetic touch handlers are passive and can't).
 */
export function usePinchZoom(
  ref: RefObject<HTMLElement | null>,
  scale: number,
  onScaleChange: (s: number) => void,
) {
  // Mirror the latest values into refs so the effect binds its
  // listeners once, not on every scale change.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const cbRef = useRef(onScaleChange);
  cbRef.current = onScaleChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startDist = 0;
    let startScale = 1;
    let pinching = false;

    const distance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinching = true;
        startDist = distance(e.touches) || 1;
        startScale = scaleRef.current;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault(); // stop the container scrolling/selecting mid-pinch
      const ratio = distance(e.touches) / startDist;
      cbRef.current(clamp(startScale * ratio));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinching = false;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);
}
