"use client";

import { useMemo, useState } from "react";

import {
  type ImageLayer,
  type Resources,
  type Slide,
  type SlideShape,
  type SlidesContent,
  type TextLayer,
  colorRefToCss,
  lengthToPx,
} from "@/lib/udm";

interface SlideViewProps {
  content: SlidesContent;
  resources: Resources;
}

const PREVIEW_MAX_WIDTH = 800;

/** Read-only slides viewer: thumbnail strip on the left, selected
 * slide rendered larger on the right. v1 renders text + image shapes
 * via absolute-positioned divs (DOM), not canvas. */
export function SlideView({ content, resources }: SlideViewProps) {
  const slides = content.slides ?? [];
  const [active, setActive] = useState(0);
  const current = slides[active];
  if (slides.length === 0) {
    return (
      <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
        empty presentation
      </div>
    );
  }
  return (
    <div className="border border-border bg-surface">
      <div className="flex items-stretch" style={{ minHeight: 320 }}>
        <div
          className="border-r border-border bg-bg/40 p-3 flex flex-col gap-2 overflow-y-auto"
          style={{ width: 180, maxHeight: "75vh" }}
        >
          {slides.map((slide, idx) => (
            <SlideThumb
              key={slide.id || idx}
              slide={slide}
              resources={resources}
              active={idx === active}
              onSelect={() => setActive(idx)}
              index={idx + 1}
            />
          ))}
        </div>
        <div className="flex-1 p-4 overflow-auto" style={{ maxHeight: "75vh" }}>
          {current ? <SlideStage slide={current} resources={resources} editable={false} /> : null}
        </div>
      </div>
    </div>
  );
}

export function SlideEditor({
  content,
  resources,
  onChange,
}: {
  content: SlidesContent;
  resources: Resources;
  onChange: (next: SlidesContent) => void;
}) {
  const slides = content.slides ?? [];
  const [active, setActive] = useState(0);
  const current = slides[active];
  if (slides.length === 0) {
    return (
      <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
        empty presentation
      </div>
    );
  }
  const updateShapeText = (slideIdx: number, shapeIdx: number, text: string) => {
    const next: Slide[] = slides.map((s, i) => {
      if (i !== slideIdx) return s;
      const shapes = s.shapes.map((sh, j) => {
        if (j !== shapeIdx) return sh;
        if (sh.layer.type !== "text") return sh;
        const runs = (sh.layer as TextLayer).runs;
        if (runs.length === 0) return sh;
        const updatedRuns = runs.map((run, idx) =>
          idx === 0 ? { ...run, text } : run
        );
        return { ...sh, layer: { ...sh.layer, runs: updatedRuns } };
      });
      return { ...s, shapes };
    });
    onChange({ ...content, slides: next });
  };
  return (
    <div className="border border-border bg-surface">
      <div className="flex items-stretch" style={{ minHeight: 320 }}>
        <div
          className="border-r border-border bg-bg/40 p-3 flex flex-col gap-2 overflow-y-auto"
          style={{ width: 180, maxHeight: "75vh" }}
        >
          {slides.map((slide, idx) => (
            <SlideThumb
              key={slide.id || idx}
              slide={slide}
              resources={resources}
              active={idx === active}
              onSelect={() => setActive(idx)}
              index={idx + 1}
            />
          ))}
        </div>
        <div className="flex-1 p-4 overflow-auto" style={{ maxHeight: "75vh" }}>
          {current ? (
            <SlideStage
              slide={current}
              resources={resources}
              editable
              onShapeText={(shapeIdx, text) => updateShapeText(active, shapeIdx, text)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SlideThumb({
  slide,
  resources,
  active,
  onSelect,
  index,
}: {
  slide: Slide;
  resources: Resources;
  active: boolean;
  onSelect: () => void;
  index: number;
}) {
  const wPx = lengthToPx(slide.width);
  const scale = useMemo(() => {
    return 150 / Math.max(wPx, 1);
  }, [wPx]);
  return (
    <button
      onClick={onSelect}
      className={
        "block text-left border " +
        (active ? "border-accent" : "border-border hover:border-fg")
      }
      style={{ background: "#fff" }}
    >
      <div
        style={{
          width: 150,
          height: lengthToPx(slide.height) * scale,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {slide.shapes.map((shape, idx) => (
          <ShapePreview key={idx} shape={shape} resources={resources} scale={scale} thumb />
        ))}
      </div>
      <div className="font-mono text-[0.6rem] text-subtle px-1.5 py-1 border-t border-border">
        {index}. {firstText(slide) || "(blank)"}
      </div>
    </button>
  );
}

function SlideStage({
  slide,
  resources,
  editable,
  onShapeText,
}: {
  slide: Slide;
  resources: Resources;
  editable: boolean;
  onShapeText?: (shapeIdx: number, text: string) => void;
}) {
  const wPx = lengthToPx(slide.width);
  const hPx = lengthToPx(slide.height);
  // Fit slide into the available width while preserving aspect.
  const scale = Math.min(PREVIEW_MAX_WIDTH / Math.max(wPx, 1), 1.0);
  return (
    <div
      className="border border-border"
      style={{
        width: wPx * scale,
        height: hPx * scale,
        position: "relative",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      {slide.shapes.map((shape, idx) => (
        <ShapePreview
          key={idx}
          shape={shape}
          resources={resources}
          scale={scale}
          editable={editable}
          onChangeText={(text) => onShapeText?.(idx, text)}
        />
      ))}
    </div>
  );
}

function ShapePreview({
  shape,
  resources,
  scale,
  thumb = false,
  editable = false,
  onChangeText,
}: {
  shape: SlideShape;
  resources: Resources;
  scale: number;
  thumb?: boolean;
  editable?: boolean;
  onChangeText?: (text: string) => void;
}) {
  const layer = shape.layer;
  if (layer.type === "text") {
    const text = layer as TextLayer;
    if (text.runs.length === 0) return null;
    const run = text.runs[0];
    const x = lengthToPx(run.x) * scale;
    const y = lengthToPx(run.y) * scale;
    const fontSize = lengthToPx(run.font_size) * scale;
    const top = y - fontSize * 0.8;
    const style: React.CSSProperties = {
      position: "absolute",
      left: x,
      top,
      fontSize,
      color: colorRefToCss(run.color, undefined) || "#111",
      whiteSpace: "pre-wrap",
      lineHeight: 1.2,
    };
    if (thumb || !editable) {
      return (
        <div style={style} title={shape.placeholder || ""}>
          {run.text}
        </div>
      );
    }
    return (
      <div
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const v = e.currentTarget.textContent ?? "";
          if (v !== run.text) onChangeText?.(v);
        }}
        style={{ ...style, outline: "none", minWidth: 40 }}
        title={shape.placeholder || ""}
      >
        {run.text}
      </div>
    );
  }
  if (layer.type === "image") {
    const img = layer as ImageLayer;
    const resource = resources.images.find((r) => r.id === img.image_id);
    if (!resource?.data_ref) return null;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resource.data_ref}
        alt=""
        style={{
          position: "absolute",
          left: lengthToPx(img.x) * scale,
          top: lengthToPx(img.y) * scale,
          width: lengthToPx(img.width) * scale,
          height: lengthToPx(img.height) * scale,
        }}
      />
    );
  }
  return null;
}

function firstText(slide: Slide): string {
  for (const shape of slide.shapes) {
    if (shape.layer.type === "text") {
      const text = shape.layer as TextLayer;
      if (text.runs[0]?.text) return text.runs[0].text.slice(0, 40);
    }
  }
  return "";
}
