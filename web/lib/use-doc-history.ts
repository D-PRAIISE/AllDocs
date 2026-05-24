"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Generic past / present / future history hook with opt-in coalescing.
 *
 * Each call to `set(next)` pushes the previous present onto the past stack
 * and clears the future stack. Pass `coalesceKey` to merge consecutive
 * updates sharing the same key (within `coalesceWindowMs`) into a single
 * history entry — typing one character at a time in the same text run
 * becomes one undo step rather than one-per-keystroke. Dragging a layer
 * works the same way: the per-pixel update events collapse to one entry
 * for the whole drag.
 *
 * Discrete operations (add page, delete layer, change color) pass no
 * key, so each is its own entry.
 *
 * Memory: bounded by `maxEntries` (default 100) on each side.
 */
export interface UseHistoryOptions {
  maxEntries?: number;
  coalesceWindowMs?: number;
}

export interface UseHistoryResult<T> {
  state: T;
  set: (next: T, coalesceKey?: string) => void;
  reset: (to: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const DEFAULT_MAX = 100;
const DEFAULT_WINDOW_MS = 600;

export function useHistory<T>(
  initial: T,
  options: UseHistoryOptions = {}
): UseHistoryResult<T> {
  const max = options.maxEntries ?? DEFAULT_MAX;
  const windowMs = options.coalesceWindowMs ?? DEFAULT_WINDOW_MS;

  const [state, setStateRaw] = useState<T>(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  // Bump on history-shape changes so canUndo / canRedo re-render.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const set = useCallback(
    (next: T, coalesceKey?: string) => {
      const now = Date.now();
      const last = lastCoalesceRef.current;
      const coalesce =
        coalesceKey !== undefined &&
        last !== null &&
        last.key === coalesceKey &&
        now - last.at < windowMs;

      if (!coalesce) {
        // Push the prior present onto the past — this is what undo will
        // restore.
        pastRef.current.push(state);
        if (pastRef.current.length > max) pastRef.current.shift();
      }
      // Any new edit invalidates the redo stack.
      if (futureRef.current.length > 0) futureRef.current = [];
      lastCoalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
      setStateRaw(next);
      rerender();
    },
    [state, max, windowMs, rerender]
  );

  const reset = useCallback(
    (to: T) => {
      pastRef.current = [];
      futureRef.current = [];
      lastCoalesceRef.current = null;
      setStateRaw(to);
      rerender();
    },
    [rerender]
  );

  const undo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0) return;
    const prev = past.pop()!;
    futureRef.current.push(state);
    if (futureRef.current.length > max) futureRef.current.shift();
    lastCoalesceRef.current = null;
    setStateRaw(prev);
    rerender();
  }, [state, max, rerender]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;
    const next = future.pop()!;
    pastRef.current.push(state);
    if (pastRef.current.length > max) pastRef.current.shift();
    lastCoalesceRef.current = null;
    setStateRaw(next);
    rerender();
  }, [state, max, rerender]);

  return {
    state,
    set,
    reset,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  };
}
