"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  type Document,
  type FixedContent,
  type FlowContent,
  type Resources,
  type SheetContent,
  type SlidesContent,
  lengthToPx,
} from "@/lib/udm";
import { fitScaleForWidth, useIsMobile } from "@/lib/use-is-mobile";
import { usePinchZoom } from "@/lib/use-pinch-zoom";
import { FixedPageView } from "./FixedPageView";
import { FlowContentView } from "./FlowContentView";
import { SheetView } from "./SheetView";
import { SlideView } from "./SlideView";
import { ZoomControl } from "./ZoomControl";

interface UdmViewerProps {
  doc: Document;
}

export function UdmViewer({ doc }: UdmViewerProps) {
  const [scale, setScale] = useState(1);
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const isMobile = useIsMobile();

  // First page width in px (96 DPI), used by fit-to-width.
  const firstPageWidthPx =
    doc.mode === "fixed"
      ? lengthToPx((doc.content as FixedContent).pages[0]?.width ?? { value: 0, unit: "px" })
      : 0;
  const fitToWidth = () => {
    if (firstPageWidthPx > 0) setScale(fitScaleForWidth(firstPageWidthPx));
  };

  // On a phone, default to fitting the page to the screen so the
  // document is readable instead of ~2x too wide. Runs once per doc.
  const didFit = useRef(false);
  useEffect(() => {
    didFit.current = false;
  }, [doc]);
  useEffect(() => {
    if (didFit.current || !isMobile || firstPageWidthPx <= 0) return;
    setScale(fitScaleForWidth(firstPageWidthPx));
    didFit.current = true;
  }, [isMobile, firstPageWidthPx]);

  return (
    <div className="space-y-4">
      <FontFaceStyles resources={doc.resources} />
      <ContentRenderer
        doc={doc}
        scale={scale}
        onScaleChange={setScale}
        onFit={fitToWidth}
        layout={layout}
        onLayoutChange={(l) => {
          setLayout(l);
          setScale((s) => (l === "grid" && s > 0.5 ? 0.4 : l === "list" && s < 0.5 ? 1 : s));
        }}
      />
    </div>
  );
}

export function FontFaceStyles({ resources }: { resources: Resources }) {
  const css = useMemo(
    () =>
      resources.fonts
        .filter((f) => f.data_ref)
        .map(
          (f) => `@font-face {
  font-family: "udm-${f.id}";
  src: url("${f.data_ref}");
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: swap;
}`
        )
        .join("\n"),
    [resources.fonts]
  );
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

function ContentRenderer({
  doc,
  scale,
  onScaleChange,
  onFit,
  layout,
  onLayoutChange,
}: {
  doc: Document;
  scale: number;
  onScaleChange: (s: number) => void;
  onFit: () => void;
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
}) {
  const pinchRef = useRef<HTMLDivElement>(null);
  usePinchZoom(pinchRef, scale, onScaleChange);
  if (doc.mode === "fixed") {
    const fixed = doc.content as FixedContent;
    return (
      <div>
        <ScaleControl
          scale={scale}
          onScaleChange={onScaleChange}
          onFit={onFit}
          layout={layout}
          onLayoutChange={onLayoutChange}
        />
        <div
          ref={pinchRef}
          className={
            (layout === "grid"
              ? "flex flex-wrap gap-6 [justify-content:safe_center]"
              : "space-y-6 flex flex-col [align-items:safe_center]") +
            " overflow-y-auto overflow-x-auto border border-border bg-bg/40 p-4"
          }
          // `safe center`: centre children when they fit, fall back to
          // left/top when they don't. Without it, zooming a wide page
          // pushes overflow off the left where scrollbars can't reach.
          // touch-action pan-x/pan-y: one finger scrolls, two-finger
          // pinch is handled by usePinchZoom (zooms the doc, not the page).
          style={{ maxHeight: "75vh", touchAction: "pan-x pan-y" }}
        >
          {fixed.pages.map((page) => (
            <div key={page.number}>
              <div className="label mb-2">
                page {page.number} · {Math.round(lengthToPx(page.width))}×
                {Math.round(lengthToPx(page.height))}px
              </div>
              <FixedPageView page={page} resources={doc.resources} scale={scale} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (doc.mode === "flow") {
    const flow = doc.content as FlowContent;
    return <FlowContentView blocks={flow.blocks} resources={doc.resources} />;
  }

  if (doc.mode === "sheet") {
    const sheet = doc.content as SheetContent;
    return <SheetView content={sheet} />;
  }

  if (doc.mode === "slides") {
    const slides = doc.content as SlidesContent;
    return <SlideView content={slides} resources={doc.resources} />;
  }

  return (
    <div className="border border-border bg-surface px-4 py-6 font-mono text-xs text-muted">
      mode <span className="text-accent">{doc.mode}</span> not yet supported
      (v0.1 renders fixed, flow, sheet, and slides).
    </div>
  );
}

function ScaleControl({
  scale,
  onScaleChange,
  onFit,
  layout,
  onLayoutChange,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
  onFit: () => void;
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
}) {
  const cls = (active: boolean) =>
    `font-mono text-xs px-2 py-1 border transition-colors shrink-0 ${
      active
        ? "bg-accent text-accent-fg border-accent"
        : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
    }`;
  // On phones the controls scroll in a single row instead of wrapping
  // into several rows that eat the screen above the document.
  return (
    <div className="flex items-center gap-1 mb-3 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-visible">
      <ZoomControl scale={scale} onScaleChange={onScaleChange} onFit={onFit} />
      <span className="label mx-2 shrink-0">view</span>
      <button onClick={() => onLayoutChange("list")} className={cls(layout === "list")}>
        ☰ list
      </button>
      <button onClick={() => onLayoutChange("grid")} className={cls(layout === "grid")}>
        ▦ grid
      </button>
    </div>
  );
}
