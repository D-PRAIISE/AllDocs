"use client";

/**
 * Free zoom control — a slider plus −/+ nudge and a % readout that
 * resets to 100% on click. Replaces fixed zoom presets so the user
 * picks any zoom they want. Shared by the viewer and the editor.
 *
 * Kept in its own module (no react-konva import) so the viewer can use
 * it without pulling the canvas editor into the SSR path.
 */

export function ZoomControl({
  scale,
  onScaleChange,
}: {
  scale: number;
  onScaleChange: (s: number) => void;
}) {
  const clamp = (s: number) => Math.max(0.1, Math.min(4, Math.round(s * 100) / 100));
  const nudgeBtn =
    "font-mono text-xs w-6 h-6 border border-border text-muted hover:text-fg hover:border-fg";
  return (
    <div className="flex items-center gap-1.5">
      <span className="label mr-1">zoom</span>
      <button className={nudgeBtn} onClick={() => onScaleChange(clamp(scale - 0.1))} title="zoom out">
        −
      </button>
      <input
        type="range"
        min={0.1}
        max={4}
        step={0.05}
        value={scale}
        onChange={(e) => onScaleChange(clamp(Number(e.target.value)))}
        className="w-28 accent-accent"
        title="zoom"
      />
      <button className={nudgeBtn} onClick={() => onScaleChange(clamp(scale + 0.1))} title="zoom in">
        ＋
      </button>
      <button
        className="font-mono text-xs px-1.5 h-6 border border-border text-muted hover:text-fg hover:border-fg tabular-nums"
        onClick={() => onScaleChange(1)}
        title="reset to 100%"
      >
        {Math.round(scale * 100)}%
      </button>
    </div>
  );
}
