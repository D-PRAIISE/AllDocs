"use client";

import { useMemo, useState } from "react";

import type { Cell, CellValue, Sheet, SheetContent } from "@/lib/udm";

interface SheetViewProps {
  content: SheetContent;
}

/** Read-only sheet viewer. Renders each sheet as a scrollable HTML
 * table; tabs switch between sheets. Cells show the formula's cached
 * display when present (we don't evaluate formulas client-side). */
export function SheetView({ content }: SheetViewProps) {
  const sheets = content.sheets ?? [];
  const [active, setActive] = useState(0);
  const current = sheets[active];

  if (sheets.length === 0) {
    return (
      <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
        empty workbook
      </div>
    );
  }

  return (
    <div className="border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {sheets.map((sheet, idx) => (
          <button
            key={sheet.name + idx}
            onClick={() => setActive(idx)}
            className={
              "font-mono text-xs px-2 py-1 border " +
              (idx === active
                ? "bg-accent text-accent-fg border-accent"
                : "bg-transparent text-muted border-border hover:border-fg hover:text-fg")
            }
          >
            {sheet.name || `Sheet ${idx + 1}`}
          </button>
        ))}
      </div>
      {current ? <SheetTable sheet={current} editable={false} onCellChange={undefined} /> : null}
    </div>
  );
}

/** Editable sheet view used by the sheet editor. Each cell is an
 * input that commits to the UDM on blur. */
export function SheetEditor({
  content,
  onChange,
}: {
  content: SheetContent;
  onChange: (next: SheetContent) => void;
}) {
  const sheets = content.sheets ?? [];
  const [active, setActive] = useState(0);
  const current = sheets[active];

  if (sheets.length === 0) {
    return (
      <div className="border border-border bg-surface px-4 py-12 text-center font-mono text-xs uppercase tracking-wider text-muted">
        empty workbook
      </div>
    );
  }

  const updateCell = (addr: string, raw: string) => {
    const nextSheets = sheets.map((s, i) => {
      if (i !== active) return s;
      const cells = { ...(s.cells ?? {}) };
      const isFormula = raw.startsWith("=");
      const existing = cells[addr] || ({ value: { kind: "empty" } } as Cell);
      let value: CellValue = { kind: "empty" };
      let formula: string | undefined;
      if (isFormula) {
        formula = raw;
        // Leave the cached value empty — Excel/Numbers will compute
        // on open. We don't run a formula engine client-side.
        value = { kind: "empty" };
      } else if (raw === "") {
        value = { kind: "empty" };
      } else if (raw === "TRUE" || raw === "true") {
        value = { kind: "boolean", value: true };
      } else if (raw === "FALSE" || raw === "false") {
        value = { kind: "boolean", value: false };
      } else if (!isNaN(Number(raw)) && raw.trim() !== "") {
        value = { kind: "number", value: Number(raw) };
      } else {
        value = { kind: "string", value: raw };
      }
      cells[addr] = { ...existing, value, formula };
      if (!formula) delete (cells[addr] as Cell).formula;
      return { ...s, cells };
    });
    onChange({ ...content, sheets: nextSheets });
  };

  return (
    <div className="border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        {sheets.map((sheet, idx) => (
          <button
            key={sheet.name + idx}
            onClick={() => setActive(idx)}
            className={
              "font-mono text-xs px-2 py-1 border " +
              (idx === active
                ? "bg-accent text-accent-fg border-accent"
                : "bg-transparent text-muted border-border hover:border-fg hover:text-fg")
            }
          >
            {sheet.name || `Sheet ${idx + 1}`}
          </button>
        ))}
      </div>
      {current ? <SheetTable sheet={current} editable onCellChange={updateCell} /> : null}
    </div>
  );
}

function SheetTable({
  sheet,
  editable,
  onCellChange,
}: {
  sheet: Sheet;
  editable: boolean;
  onCellChange?: (addr: string, raw: string) => void;
}) {
  const cells = sheet.cells ?? {};
  // Compute the visible grid extent: 1..max-row, A..max-col, plus a
  // small viewport buffer so the user can scroll past the last cell.
  const { maxRow, maxCol } = useMemo(() => computeBounds(cells), [cells]);
  const rowCount = Math.max(maxRow, 20);
  const colCount = Math.max(maxCol, 8);
  const rows = Array.from({ length: rowCount }, (_, i) => i + 1);
  const cols = Array.from({ length: colCount }, (_, i) => colLetter(i + 1));

  return (
    <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
      <table
        className="font-mono text-xs border-collapse"
        style={{ tableLayout: "fixed", minWidth: "100%" }}
      >
        <thead>
          <tr>
            <th
              className="bg-elevated border border-border text-subtle"
              style={{ width: 40, position: "sticky", left: 0, top: 0, zIndex: 2 }}
            />
            {cols.map((c) => (
              <th
                key={c}
                className="bg-elevated border border-border text-subtle text-center px-2 py-1"
                style={{ minWidth: 96, position: "sticky", top: 0, zIndex: 1 }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th
                className="bg-elevated border border-border text-subtle text-center"
                style={{ width: 40, position: "sticky", left: 0, zIndex: 1 }}
              >
                {r}
              </th>
              {cols.map((c) => {
                const addr = `${c}${r}`;
                const cell = cells[addr];
                return (
                  <td
                    key={addr}
                    className="border border-border align-top"
                    style={{ padding: 0 }}
                  >
                    <SheetCell
                      addr={addr}
                      cell={cell}
                      editable={editable}
                      onCommit={onCellChange}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SheetCell({
  addr,
  cell,
  editable,
  onCommit,
}: {
  addr: string;
  cell?: Cell;
  editable: boolean;
  onCommit?: (addr: string, raw: string) => void;
}) {
  const display = cellRawText(cell);
  if (!editable) {
    return (
      <div className="px-2 py-1 text-fg whitespace-nowrap overflow-hidden text-ellipsis" title={display}>
        {display}
      </div>
    );
  }
  return (
    <input
      type="text"
      defaultValue={display}
      onBlur={(e) => {
        const v = e.currentTarget.value;
        if (v !== display && onCommit) onCommit(addr, v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.currentTarget.value = display;
          e.currentTarget.blur();
        }
      }}
      className="w-full px-2 py-1 bg-transparent font-mono text-xs text-fg outline-none focus:bg-bg focus:ring-1 focus:ring-accent"
      style={{ color: "#111", caretColor: "#111", background: "#fff", border: 0 }}
      title={cell?.formula || display}
    />
  );
}

function cellRawText(cell: Cell | undefined): string {
  if (!cell) return "";
  if (cell.formula) return cell.formula;
  if (cell.display) return cell.display;
  const v = cell.value;
  switch (v.kind) {
    case "number":
      return String(v.value);
    case "string":
      return v.value;
    case "boolean":
      return v.value ? "TRUE" : "FALSE";
    case "date":
      return v.value;
    case "error":
      return `#${v.code}`;
    case "empty":
      return "";
  }
}

function computeBounds(cells: Record<string, Cell>): { maxRow: number; maxCol: number } {
  let maxRow = 0;
  let maxCol = 0;
  for (const addr of Object.keys(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(addr);
    if (!m) continue;
    maxCol = Math.max(maxCol, colIndex(m[1]));
    maxRow = Math.max(maxRow, parseInt(m[2], 10));
  }
  return { maxRow, maxCol };
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}
