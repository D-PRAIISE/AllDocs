"use client";

import { useEffect, useState } from "react";

import { type Document, type FixedContent, lengthToPx } from "@/lib/udm";
import { FixedPageView } from "./FixedPageView";

interface UdmViewerProps {
  src: string;
}

export function UdmViewer({ src }: UdmViewerProps) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${src}: ${r.status}`);
        return r.json() as Promise<Document>;
      })
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (error) {
    return (
      <div className="p-6 text-red-700 bg-red-50 border border-red-200 rounded">
        Error loading <code className="font-mono">{src}</code>: {error}
      </div>
    );
  }
  if (!doc) {
    return <div className="p-6 text-neutral-500">Loading {src}...</div>;
  }

  return (
    <div className="space-y-6">
      <DocumentSummary doc={doc} />
      <ContentRenderer doc={doc} scale={scale} onScaleChange={setScale} />
    </div>
  );
}

function DocumentSummary({ doc }: { doc: Document }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 text-sm">
      <div className="font-mono text-xs text-neutral-500 mb-1">{doc.id}</div>
      <div className="font-medium">{doc.metadata.title ?? "(no title)"}</div>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-neutral-600">
        <dt>Mode</dt>
        <dd className="font-mono">{doc.mode}</dd>
        <dt>UDM version</dt>
        <dd className="font-mono">{doc.udm_version}</dd>
        <dt>Source</dt>
        <dd className="font-mono">
          {doc.metadata.source_format.mime}
          {doc.metadata.source_format.producer ? ` (${doc.metadata.source_format.producer})` : ""}
        </dd>
        <dt>Fonts</dt>
        <dd>
          {doc.resources.fonts.length} (
          {doc.resources.fonts.filter((f) => f._meta?.subset).length} subset)
        </dd>
        <dt>Images</dt>
        <dd>{doc.resources.images.length}</dd>
      </dl>
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
  if (doc.mode !== "fixed") {
    return (
      <div className="p-6 text-neutral-500 bg-white rounded border border-neutral-200">
        Mode <code className="font-mono">{doc.mode}</code> not yet supported in this viewer (v0.1
        renders fixed-mode only).
      </div>
    );
  }
  const fixed = doc.content as FixedContent;
  return (
    <div>
      <ScaleControl scale={scale} onScaleChange={onScaleChange} />
      <div className="space-y-8 flex flex-col items-center">
        {fixed.pages.map((page) => (
          <div key={page.number} className="text-xs text-neutral-500">
            <div className="mb-1">
              page {page.number} · {Math.round(lengthToPx(page.width))}×
              {Math.round(lengthToPx(page.height))} px
            </div>
            <FixedPageView page={page} resources={doc.resources} scale={scale} />
          </div>
        ))}
      </div>
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
    <div className="flex items-center gap-2 mb-4 text-sm">
      <span className="text-neutral-500">Scale:</span>
      {presets.map((p) => (
        <button
          key={p}
          onClick={() => onScaleChange(p)}
          className={`px-2 py-1 rounded font-mono text-xs ${
            scale === p
              ? "bg-neutral-900 text-white"
              : "bg-white border border-neutral-300 hover:border-neutral-500"
          }`}
        >
          {Math.round(p * 100)}%
        </button>
      ))}
    </div>
  );
}
