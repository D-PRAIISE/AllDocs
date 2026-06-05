/**
 * Stylized, static mock of the AllDocs editor for the landing hero.
 *
 * Pure CSS/HTML — no real screenshot to keep crisp at every DPI and
 * to stay on-brand (brutalist: 1px borders, no radius, mono labels,
 * amber accent). It evokes the product so a visitor knows what
 * they're getting before they upload, without us shipping a heavy
 * image or a live editor on the marketing page.
 */
export function EditorPreviewMock() {
  return (
    <div className="border border-border bg-surface shadow-2xl select-none" aria-hidden>
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-elevated">
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="w-2.5 h-2.5 border border-border-strong" />
        <span className="ml-3 font-mono text-[0.6rem] uppercase tracking-wider text-subtle truncate">
          report.pdf · alldocs
        </span>
      </div>

      {/* toolbar strip */}
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

      {/* "document" */}
      <div className="p-5 bg-bg/40">
        <div className="mx-auto bg-white" style={{ maxWidth: 360, padding: 24 }}>
          {/* a heading line being edited (accent caret) */}
          <div className="flex items-center gap-1">
            <div className="h-3 w-40" style={{ background: "#1a1a1a" }} />
            <div className="h-4 w-px bg-[#c67700] animate-pulse" />
          </div>
          <div className="mt-3 h-2 w-full bg-neutral-200" />
          <div className="mt-1.5 h-2 w-11/12 bg-neutral-200" />
          <div className="mt-1.5 h-2 w-10/12 bg-neutral-200" />

          {/* an image block with selection handles */}
          <div className="mt-4 relative" style={{ width: 120, height: 70 }}>
            <div className="w-full h-full bg-neutral-100 border border-dashed border-neutral-300 flex items-center justify-center">
              <span className="font-mono text-[0.5rem] text-neutral-400">IMG</span>
            </div>
            {/* selection outline + corner handles */}
            <div className="absolute inset-0 border" style={{ borderColor: "#5b9bd5" }} />
            {[
              "left-0 top-0",
              "right-0 top-0",
              "left-0 bottom-0",
              "right-0 bottom-0",
            ].map((pos) => (
              <span
                key={pos}
                className={`absolute ${pos} w-1.5 h-1.5 bg-white`}
                style={{ border: "1px solid #5b9bd5", transform: "translate(-50%,-50%)" }}
              />
            ))}
          </div>

          <div className="mt-4 h-2 w-full bg-neutral-200" />
          <div className="mt-1.5 h-2 w-9/12 bg-neutral-200" />

          {/* a highlighted line */}
          <div className="mt-3 h-3 w-7/12" style={{ background: "rgba(252,196,106,0.5)" }} />
        </div>
      </div>
    </div>
  );
}
