"use client";

import dynamic from "next/dynamic";

import type { Document } from "@/lib/udm";

// react-konva touches window.Image / window.HTMLCanvasElement at module scope,
// so the whole canvas component must be loaded client-only. Loading individual
// primitives (Stage, Layer, Text, ...) via separate dynamic() calls produces
// distinct module instances and the children don't mount inside the Stage —
// the canvas renders as a blank area. One dynamic() at the wrapper level is
// the standard react-konva + Next.js pattern.
const FixedEditorCanvas = dynamic(() => import("./FixedEditorCanvas"), {
  ssr: false,
  loading: () => (
    <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
      loading editor…
    </div>
  ),
});

interface FixedEditorProps {
  doc: Document;
  onChange: (next: Document, coalesceKey?: string) => void;
}

export function FixedEditor({ doc, onChange }: FixedEditorProps) {
  return <FixedEditorCanvas doc={doc} onChange={onChange} />;
}
