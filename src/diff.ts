import type { Theme } from "./theme.js";

/**
 * Line diff between a file that was attached and the version the model wrote
 * back. Printing the whole file again makes the reader find the change; a diff
 * shows it. Myers' algorithm, bounded — an "edit" that rewrites everything is
 * a new file, not a change, and is better reported as one.
 */

export type DiffKind = "keep" | "add" | "remove";

export interface DiffOp {
  kind: DiffKind;
  line: string;
}

/** How far apart two sides may be before a diff stops being the useful view. */
export const DEFAULT_MAX_EDITS = 1_200;

function backtrack(before: string[], after: string[], trace: Map<number, number>[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    if (!v) continue;
    const k = x - y;
    const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ kind: "keep", line: before[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    if (down) {
      ops.push({ kind: "add", line: after[previousY] ?? "" });
      y = previousY;
    } else {
      ops.push({ kind: "remove", line: before[previousX] ?? "" });
      x = previousX;
    }
  }
  return ops.reverse();
}

/**
 * The edit script turning `before` into `after`, or undefined when the two
 * differ by more than `maxEdits` lines.
 */
export function diffLines(before: string[], after: string[], maxEdits = DEFAULT_MAX_EDITS): DiffOp[] | undefined {
  const n = before.length;
  const m = after.length;
  const limit = Math.min(maxEdits, n + m);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const goDown = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = goDown ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(before, after, trace);
    }
  }
  return undefined;
}

export interface DiffSummary {
  added: number;
  removed: number;
  kept: number;
}

export function summarizeDiff(ops: readonly DiffOp[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, kept: 0 };
  for (const op of ops) {
    if (op.kind === "add") summary.added += 1;
    else if (op.kind === "remove") summary.removed += 1;
    else summary.kept += 1;
  }
  return summary;
}

/**
 * Whether `after` reads as an edit of `before` rather than unrelated code.
 * Used to decide if offering a diff makes sense at all.
 */
export function looksLikeEdit(ops: readonly DiffOp[], before: number, after: number): boolean {
  const { kept } = summarizeDiff(ops);
  const smaller = Math.min(before, after);
  if (smaller === 0) return false;
  return kept >= smaller / 2;
}

export interface RenderDiffOptions {
  /** Unchanged lines kept around each change. */
  context?: number;
  /** Cap on printed lines; the rest is reported as a count. */
  maxLines?: number;
}

/**
 * A unified-style rendering: changed lines with a little context, the runs of
 * untouched lines between them collapsed.
 */
export function renderDiff(ops: readonly DiffOp[], theme: Theme, options: RenderDiffOptions = {}): string[] {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 200;
  const shown = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind === "keep") return;
    for (let offset = -context; offset <= context; offset += 1) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < ops.length) shown.add(neighbour);
    }
  });

  const lines: string[] = [];
  let skipped = 0;
  let truncated = 0;
  const flushSkipped = (): void => {
    if (skipped === 0) return;
    lines.push(theme.muted(`  ⋯ ${skipped} 行未变`));
    skipped = 0;
  };
  ops.forEach((op, index) => {
    if (!shown.has(index)) {
      skipped += 1;
      return;
    }
    flushSkipped();
    if (lines.length >= maxLines) {
      truncated += 1;
      return;
    }
    if (op.kind === "add") lines.push(theme.green(`+ ${op.line}`));
    else if (op.kind === "remove") lines.push(theme.red(`- ${op.line}`));
    else lines.push(theme.muted(`  ${op.line}`));
  });
  flushSkipped();
  if (truncated > 0) lines.push(theme.muted(`  ⋯ 还有 ${truncated} 行差异未显示`));
  return lines;
}
