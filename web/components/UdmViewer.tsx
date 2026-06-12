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
import { findTextMatches, matchKey } from "@/lib/text-search";
import { FixedPageView } from "./FixedPageView";
import { SearchBar } from "./SearchBar";
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

  // Find-in-document (fixed mode). State lives here unconditionally so
  // the hooks stay stable across modes; only the fixed branch uses it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const fixedForSearch = doc.mode === "fixed" ? (doc.content as FixedContent) : null;
  const searchMatches = useMemo(
    () => (fixedForSearch ? findTextMatches(fixedForSearch, searchQuery, scale) : []),
    [fixedForSearch, searchQuery, scale],
  );
  useEffect(() => {
    if (searchMatches.length === 0 || searchActiveIdx >= searchMatches.length) {
      setSearchActiveIdx(0);
    }
  }, [searchMatches, searchActiveIdx]);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const m = searchMatches[searchActiveIdx];
    const el = m ? pageRefs.current[m.pageIdx] : null;
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [searchActiveIdx, searchMatches, searchOpen]);
  // Ctrl/Cmd+F opens search (and Esc closes) for desktop parity with
  // the editor; the toolbar button covers touch.
  useEffect(() => {
    if (doc.mode !== "fixed") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc.mode, searchOpen]);
  const activeKey = searchMatches[searchActiveIdx]
    ? matchKey(searchMatches[searchActiveIdx])
    : null;

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
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((o) => !o)}
        />
        {searchOpen && (
          <div className="mb-3">
            <SearchBar
              query={searchQuery}
              onQueryChange={(q) => {
                setSearchQuery(q);
                setSearchActiveIdx(0);
              }}
              totalMatches={searchMatches.length}
              activeIdx={searchActiveIdx}
              onPrev={() =>
                setSearchActiveIdx((i) =>
                  searchMatches.length === 0 ? 0 : (i - 1 + searchMatches.length) % searchMatches.length
                )
              }
              onNext={() =>
                setSearchActiveIdx((i) => (searchMatches.length === 0 ? 0 : (i + 1) % searchMatches.length))
              }
              onClose={() => setSearchOpen(false)}
            />
          </div>
        )}
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
          {fixed.pages.map((page, pageIdx) => (
            <div
              key={page.number}
              ref={(el) => {
                pageRefs.current[pageIdx] = el;
              }}
            >
              <div className="label mb-2">
                page {page.number} · {Math.round(lengthToPx(page.width))}×
                {Math.round(lengthToPx(page.height))}px
              </div>
              <FixedPageView
                page={page}
                resources={doc.resources}
                scale={scale}
                searchMatches={searchMatches.filter((m) => m.pageIdx === pageIdx)}
                activeMatchKey={activeKey}
              />
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
  searchOpen,
  onToggleSearch,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
  onFit: () => void;
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
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
      <button
        onClick={onToggleSearch}
        className={cls(searchOpen)}
        title="Find text in document (Ctrl+F)"
      >
        🔍 find
      </button>
    </div>
  );
}
