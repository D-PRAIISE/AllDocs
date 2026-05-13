"use client";

import { useMemo, useState } from "react";

import {
  type Document,
  type FixedContent,
  type FlowContent,
  type Resources,
  lengthToPx,
} from "@/lib/udm";
import { FixedPageView } from "./FixedPageView";
import { FlowContentView } from "./FlowContentView";

interface UdmViewerProps {
  doc: Document;
}

export function UdmViewer({ doc }: UdmViewerProps) {
  const [scale, setScale] = useState(1);
  return (
    <div className="space-y-4">
      <FontFaceStyles resources={doc.resources} />
      <DocumentSummary doc={doc} />
      <ContentRenderer doc={doc} scale={scale} onScaleChange={setScale} />
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

export function DocumentSummary({ doc }: { doc: Document }) {
  const subsets = doc.resources.fonts.filter((f) => f._meta?.subset).length;
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2">
        <div className="label">document</div>
        <div className="font-sans text-base text-fg mt-0.5">
          {doc.metadata.title ?? <span className="text-muted">(no title)</span>}
        </div>
        <div className="font-mono text-[0.65rem] text-subtle mt-0.5">{doc.id}</div>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y divide-border sm:divide-y-0 sm:divide-x">
        <Field label="mode" value={doc.mode} mono />
        <Field label="udm" value={doc.udm_version} mono />
        <Field
          label="source"
          value={doc.metadata.source_format.mime.split("/").pop() ?? doc.metadata.source_format.mime}
          mono
        />
        <Field label="fonts" value={`${doc.resources.fonts.length}${subsets ? ` · ${subsets} subset` : ""}`} mono />
        <Field label="images" value={String(doc.resources.images.length)} mono />
        <Field label="producer" value={doc.metadata.source_format.producer ?? "—"} mono />
      </dl>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="px-4 py-3">
      <dt className="label mb-1">{label}</dt>
      <dd className={`${mono ? "font-mono text-xs" : "font-sans text-sm"} text-fg`}>{value}</dd>
    </div>
  );
}

function ContentRenderer({
  doc,
  scale,
  onScaleChange,
}: {
  doc: Document;
  scale: number;
  onScaleChange: (s: number) => void;
}) {
  if (doc.mode === "fixed") {
    const fixed = doc.content as FixedContent;
    return (
      <div>
        <ScaleControl scale={scale} onScaleChange={onScaleChange} />
        <div className="space-y-6 flex flex-col items-center">
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

  return (
    <div className="border border-border bg-surface px-4 py-6 font-mono text-xs text-muted">
      mode <span className="text-accent">{doc.mode}</span> not yet supported
      (v0.1 renders fixed and flow only).
    </div>
  );
}

function ScaleControl({
  scale,
  onScaleChange,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
}) {
  const presets = [0.5, 0.75, 1, 1.25, 1.5];
  return (
    <div className="flex items-center gap-1 mb-3">
      <span className="label mr-2">scale</span>
      {presets.map((p) => (
        <button
          key={p}
          onClick={() => onScaleChange(p)}
          className={`font-mono text-xs px-2 py-1 border transition-colors ${
            scale === p
              ? "bg-accent text-accent-fg border-accent"
              : "bg-transparent text-muted border-border hover:border-fg hover:text-fg"
          }`}
        >
          {Math.round(p * 100)}%
        </button>
      ))}
    </div>
  );
}
