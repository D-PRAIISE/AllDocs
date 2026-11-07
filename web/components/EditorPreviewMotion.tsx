"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EditorPreviewMock } from "./EditorPreviewMock";

/**
 * The landing hero's editor illustration, animated.
 *
 * The static mock showed what the product *is*. This shows what it now
 * does differently: five scenes, each demonstrating one of the fixes the
 * release strip names, captioned so the motion isn't just decoration.
 *
 * Deliberately not a video or a GIF. The brand is drawn in CSS — 1px
 * borders, no radius, mono labels — so a recording would be a heavy,
 * fixed-DPI copy of something the browser renders crisply for free, and
 * it would not follow the light/dark theme.
 *
 * One scene is mounted at a time. Mounting restarts its CSS animations,
 * so nothing has to keep a timeline in sync with React's clock.
 *
 * Falls back to the still mock when the visitor asks for reduced motion.
 */

/** Slot per scene. Every keyframe settles well inside this so the result
 *  holds on screen rather than the cut landing mid-move. */
const SCENE_MS = 3400;
const DUR = `${SCENE_MS}ms`;

/** The document's own typeface, not the site's. Tinos is already loaded
 *  as a Times clone for the editor's font fallback chain. */
const DOC_SERIF = "Tinos, 'Times New Roman', serif";
const INK = "#1a1a1a";
const PAPER_RULE = "#e5e5e5";

/** Page body is a fixed height so a scene change never resizes the hero
 *  and nudges the copy beside it. Sized to fill most of the mock's
 *  window: at 360x236 the sheet floated in a wide dark margin and the
 *  document detail was too small to read at a glance, which is the
 *  whole job of the illustration. */
const PAGE_H = 300;
const PAGE_W = 470;

function Lines({ widths, className = "" }: { widths: string[]; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {widths.map((w, i) => (
        <div key={i} className="h-2.5" style={{ width: w, background: PAPER_RULE }} />
      ))}
    </div>
  );
}

/** 1 — a watermark that imported as an opaque slab, settling to the
 *  faint stamp it actually is. */
function SceneWatermark() {
  return (
    <>
      <div className="h-3.5 w-52" style={{ background: INK }} />
      <Lines className="mt-4" widths={["100%", "92%", "97%", "88%", "95%", "70%"]} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div style={{ animation: `alldocs-wm-clear ${DUR} both` }}>
          <div
            className="flex items-center justify-center"
            style={{
              width: 132,
              height: 132,
              background: "#9ca3af",
              border: "3px solid #6b7280",
              transform: "rotate(-14deg)",
            }}
          >
            <span
              className="font-mono text-[0.65rem] tracking-[0.2em]"
              style={{ color: "#f5f5f5" }}
            >
              SEAL
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** 2 — selection growing from one fragment to the whole line. */
function ScenePickLine() {
  // Percentages, not pixels: this mock also renders inside the popup,
  // whose panel is ~332px wide on a phone. Fixed widths summing to 366px
  // overflowed the sheet and pushed the selection box past its edge.
  const words = ["14%", "20%", "11%", "17%", "23%", "10%"];
  return (
    <>
      <div className="h-3.5 w-48" style={{ background: INK }} />
      <Lines className="mt-4" widths={["100%", "90%"]} />
      <div className="mt-4 relative" style={{ height: 12 }}>
        <div className="flex items-center gap-1.5">
          {words.map((w, i) => (
            <div key={i} className="h-3 shrink-0" style={{ width: w, background: "#cfcfcf" }} />
          ))}
        </div>
        <div
          className="absolute border-2"
          style={{
            left: -4,
            right: -4,
            top: -4,
            bottom: -4,
            borderColor: "#c67700",
            background: "rgba(252,196,106,0.18)",
            animation: `alldocs-pick-line ${DUR} both`,
          }}
        />
      </div>
      <Lines className="mt-5" widths={["96%", "84%"]} />
    </>
  );
}

/** 3 — a substitute font's wider glyphs running two words together,
 *  then each run squeezed back to the width its source had. */
function SceneWidth() {
  return (
    <>
      <div className="h-3.5 w-44" style={{ background: INK }} />
      <Lines className="mt-4" widths={["100%", "88%"]} />
      <div
        className="mt-5 flex items-baseline overflow-hidden"
        style={{ fontFamily: DOC_SERIF, fontSize: 22, color: INK }}
      >
        <span>GRACE</span>
        <span style={{ marginLeft: 10, animation: `alldocs-unjam ${DUR} both` }}>
          FEMALE
        </span>
      </div>
      <Lines className="mt-5" widths={["94%", "76%"]} />
    </>
  );
}

/** 4 — underline, the one attribute a PDF has no text flag for. */
function SceneUnderline() {
  return (
    <>
      <div className="flex items-center gap-1">
        {(["B", "I", "U"] as const).map((c) => (
          <span
            key={c}
            className="w-5 h-5 flex items-center justify-center font-mono text-[0.6rem]"
            style={
              c === "U"
                ? {
                    border: "1px solid #c67700",
                    color: "#c67700",
                    animation: `alldocs-chip-on ${DUR} both`,
                  }
                : { border: "1px solid #d4d4d4", color: "#9ca3af" }
            }
          >
            {c}
          </span>
        ))}
      </div>
      <Lines className="mt-5" widths={["100%", "92%", "84%"]} />
      <div className="mt-6" style={{ fontFamily: DOC_SERIF, fontSize: 22, color: INK }}>
        <span className="relative inline-block">
          Chief Medical Director
          <span
            className="absolute left-0 right-0"
            style={{
              bottom: -3,
              height: 1.5,
              background: INK,
              transformOrigin: "left",
              animation: `alldocs-rule-in ${DUR} both`,
            }}
          />
        </span>
      </div>
      <Lines className="mt-6" widths={["70%"]} />
    </>
  );
}

/** 5 — deleting mid-line text, and the offer to close the hole it
 *  leaves. The shift is measured off the deleted word rather than
 *  guessed, so the line closes exactly and not approximately. */
function SceneGap() {
  const deletedRef = useRef<HTMLSpanElement | null>(null);
  const restRef = useRef<HTMLSpanElement | null>(null);

  // Built in JS with a literal pixel distance, not as a CSS keyframe.
  //
  // Every other scene here is a CSS animation, and this one was too: a
  // keyframe that read the shift from a custom property this component
  // measured and set. That is the one thing in CSS whose timing is not
  // dependable across browsers. The property is set after the animation
  // already exists, and whether a browser then re-resolves the
  // keyframes is not something you can rely on — Chrome here did, so
  // the line closed and every measurement I took said it worked, while
  // on the reporter's desktop AND phone, on localhost and on the live
  // site, the keyframe kept the 0 it was created with and LEMUEL never
  // moved at all. The scene played its whole length showing the hole
  // and nothing else.
  //
  // element.animate takes the number by value at the moment it is
  // called, so there is nothing left to re-resolve and nothing for a
  // browser to disagree about. Offsets match the old keyframe: hold,
  // close between 32% and 52%, then hold the closed line for the rest
  // of the scene, which is the part worth looking at.
  useLayoutEffect(() => {
    const deleted = deletedRef.current;
    const rest = restRef.current;
    if (!deleted || !rest) return;
    // offsetWidth, NOT getBoundingClientRect. The scene is drawn inside
    // a scaled box, and a rect is measured in visual pixels after that
    // scale while a transform is applied in the element's own layout
    // pixels before it. Feeding a rect width to translateX therefore
    // undershoots by exactly the scale factor: at 0.61 in the popup the
    // line closed 71px of a 117px hole and stopped 28px short.
    // offsetWidth is layout-space and ignores ancestor transforms, so
    // it is right at every scale.
    const dx = deleted.offsetWidth;
    if (dx <= 0) return;
    const shift = `translateX(${-dx}px)`;
    const anim = rest.animate(
      [
        { transform: "translateX(0)", offset: 0, easing: "ease-in-out" },
        { transform: "translateX(0)", offset: 0.32, easing: "ease-in-out" },
        { transform: shift, offset: 0.52 },
        { transform: shift, offset: 1 },
      ],
      { duration: SCENE_MS, fill: "both" }
    );
    return () => anim.cancel();
  }, []);

  return (
    <>
      <div className="h-3.5 w-48" style={{ background: INK }} />
      <Lines className="mt-4" widths={["100%", "86%"]} />
      <div
        className="mt-5 flex items-baseline whitespace-pre"
        style={{ fontFamily: DOC_SERIF, fontSize: 22, color: INK }}
      >
        <span>LUCKY </span>
        <span ref={deletedRef} style={{ animation: `alldocs-word-out ${DUR} both` }}>
          {"AGHOGHO "}
        </span>
        <span ref={restRef}>LEMUEL</span>
      </div>
      <Lines className="mt-5" widths={["92%", "78%"]} />
    </>
  );
}

const SCENES = [
  { key: "watermark", caption: "watermarks keep their transparency", node: <SceneWatermark /> },
  { key: "line", caption: "click a line, get the whole line", node: <ScenePickLine /> },
  { key: "width", caption: "text keeps the width it had", node: <SceneWidth /> },
  { key: "underline", caption: "underline, and it survives export", node: <SceneUnderline /> },
  { key: "gap", caption: "deleting text closes the gap", node: <SceneGap /> },
] as const;

export function EditorPreviewMotion() {
  const [idx, setIdx] = useState(0);

  // The scenes are composed at exactly PAGE_W x PAGE_H and then scaled
  // to whatever width the sheet actually gets. They have to be: the
  // same mock renders in the hero at 470px and inside the popup on a
  // phone at ~296px, and when the composition was laid out in raw
  // pixels the narrow case clipped "LEMUEL" off the right edge and
  // wrapped "Chief Medical Director" onto two lines with its underline
  // stranded under the second. Scaling keeps one composition that is
  // correct at every width instead of a layout that happens to fit one.
  //
  // offsetWidth is unaffected by transforms, so the gap measurement in
  // SceneGap stays in design pixels and the translate still lands
  // exactly - it is simply drawn at the same scale as everything else.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [docScale, setDocScale] = useState(1);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      // Never enlarge past the design size: the hero is the intended
      // composition, not a minimum.
      if (w > 0) setDocScale(Math.min(1, w / PAGE_W));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Assume motion is wanted until the query says otherwise, so the
  // common case doesn't flash the still frame first.
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const t = window.setInterval(
      () => setIdx((i) => (i + 1) % SCENES.length),
      SCENE_MS
    );
    return () => window.clearInterval(t);
  }, [reduced]);

  if (reduced) return <EditorPreviewMock />;

  const scene = SCENES[idx];

  return (
    <div
      data-alldocs-motion
      className="border border-border bg-surface shadow-2xl select-none"
      aria-hidden
    >
      {/* window chrome — unchanged from the still mock, so the hero
          still reads as "this is the editor" at a glance */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-elevated">
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="ml-3 font-mono text-[0.6rem] uppercase tracking-wider text-subtle truncate">
          report.pdf · alldocs
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {["⬚ select", "✎ text", "▭ shape", "◐ color", "▮ mark", "☐ field"].map((t) => (
          <span
            key={t}
            className="font-mono text-[0.55rem] uppercase tracking-wider text-muted border border-border px-1.5 py-1"
          >
            {t}
          </span>
        ))}
        <span className="ml-auto font-mono text-[0.55rem] text-subtle">100%</span>
      </div>

      <div className="p-3 sm:p-4 bg-bg/40">
        <div
          ref={sheetRef}
          className="mx-auto bg-white relative overflow-hidden"
          style={{ maxWidth: PAGE_W, height: PAGE_H * docScale }}
        >
          {/* The cross-fade is on the contents, never on the sheet. Fading
              the sheet let the dark backdrop through and flashed the page
              grey at every cut, four times a minute, right beside the
              headline someone is trying to read. */}
          <div
            key={scene.key}
            className="absolute top-0 left-0"
            style={{
              width: PAGE_W,
              height: PAGE_H,
              padding: 28,
              transform: `scale(${docScale})`,
              transformOrigin: "top left",
              animation: `alldocs-scene-in 260ms both`,
            }}
          >
            {scene.node}
          </div>
        </div>
      </div>

      {/* Caption. Without it the motion is decoration; with it the hero
          tells a returning visitor what changed before they click. */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-2 bg-elevated">
        <span className="font-mono text-[0.55rem] uppercase tracking-wider text-accent border border-accent px-1 shrink-0">
          new
        </span>
        {/* Wraps rather than truncates. At popup width every caption
            was ellipsised - "deleting text closes the..." - which threw
            away the one line that says what the animation means. */}
        <span className="font-mono text-[0.6rem] text-fg/80 leading-tight min-w-0 flex-1">
          {scene.caption}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {SCENES.map((s, i) => (
            <span
              key={s.key}
              className="h-px w-3 transition-colors"
              style={{
                background:
                  i === idx ? "var(--color-accent)" : "var(--color-border-strong)",
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
