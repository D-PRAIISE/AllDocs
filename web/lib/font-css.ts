/**
 * Builds the CSS font-family chain for a text run, shared by the viewer
 * (FixedPageView) and the editor (FixedEditorCanvas) so they render text
 * identically.
 *
 * Chain (most-specific → most-generic):
 *   1. "udm-<id>"        — the @font-face'd embedded subset extracted from
 *                          the source PDF (exact glyphs the doc used).
 *   2. "<OriginalFamily>"— the named font, if the viewer happens to have it
 *                          installed (e.g. Calibri on Windows).
 *   3. "AllDocs Sans|Serif|Mono" — bundled metric-compatible open clone
 *                          (Arimo/Tinos/Cousine). Covers the common case
 *                          where the subset lacks a newly-typed glyph or
 *                          the named font isn't installed — near-identical
 *                          shape instead of a generic.
 *   4. class-correct generic (sans-serif | serif | monospace) — final
 *                          safety net that at least matches the font class.
 *
 * Mirrors services/pdf-adapter/_fonts.py classify_family so the on-screen
 * fallback matches what the exporter embeds.
 */

export type FamilyClass = "sans" | "serif" | "mono";

const MONO_PATTERNS = [
  "mono", "courier", "consolas", "monaco", "menlo", "inconsolata",
  "source code", "fira code", "ibm plex mono", "jetbrains", "cousine",
];
const SERIF_PATTERNS = [
  "serif", "times", "georgia", "cambria", "garamond", "baskerville",
  "palatino", "minion", "caslon", "didot", "bookman", "century", "tinos",
];

/** Classify a family name as sans / serif / mono. */
export function classifyFamily(family: string): FamilyClass {
  const lower = (family || "").toLowerCase();
  if (MONO_PATTERNS.some((p) => lower.includes(p))) return "mono";
  // "sans" must beat the serif scan: "sans-serif" contains "serif".
  if (lower.includes("sans")) return "sans";
  if (SERIF_PATTERNS.some((p) => lower.includes(p))) return "serif";
  return "sans";
}

const CLONE: Record<FamilyClass, string> = {
  sans: "AllDocs Sans",
  serif: "AllDocs Serif",
  mono: "AllDocs Mono",
};
const GENERIC: Record<FamilyClass, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  mono: "ui-monospace, monospace",
};

/**
 * Full font stack for a run.
 * @param family   the run's font family name.
 * @param fontId   the UDM font id, if the font has an embedded @font-face.
 */
export function cssFontStack(family: string, fontId?: string | null): string {
  const cls = classifyFamily(family);
  const parts: string[] = [];
  if (fontId) parts.push(`"udm-${fontId}"`);
  if (family) parts.push(family.includes(" ") ? `"${family}"` : family);
  parts.push(`"${CLONE[cls]}"`);
  parts.push(GENERIC[cls]);
  return parts.join(", ");
}
