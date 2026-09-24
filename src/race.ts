import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { REASONING_EFFORTS, RECOMMENDED_MODELS, type ReasoningEffort } from "./types.js";
import { ensurePrivateDirectory, isRecord } from "./fs-utils.js";
import { estimateTextTokens } from "./session-store.js";

/**
 * `/race` as a growing record rather than a one-off comparison.
 *
 * Every race ends with the user picking a winner — that pick is a labelled
 * sample of "for this kind of question, that effort was worth its price", and
 * this client is the only one in a position to collect it. Kept here so the
 * REPL only has to decide *when* to ask, not how to judge.
 */

/** What kind of question this was, decided locally from the text alone. */
export type QuestionKind = "debug" | "code" | "design" | "rewrite" | "explain" | "other";

export type QuestionSize = "small" | "medium" | "large";

export interface QuestionShape {
  kind: QuestionKind;
  size: QuestionSize;
}

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  debug: "排错",
  code: "写代码",
  design: "设计取舍",
  rewrite: "改写翻译",
  explain: "解释概念",
  other: "其他",
};

/**
 * Ordered on purpose: "为什么会报错" is a debugging question, not a request to
 * explain a concept, so the narrower intents are tested first. The split is
 * deliberately coarse and always shown to the user — a label they can see is
 * one they can disagree with.
 */
const KIND_PATTERNS: readonly (readonly [QuestionKind, RegExp])[] = [
  ["debug", /报错|错误|异常|崩溃|失败|不工作|不生效|修复|排查|traceback|stack\s?trace|\berror\b|\bbug\b|\bfix\b|\bdebug\b/iu],
  ["code", /写(一)?个|实现|重构|优化|封装|补全|代码|函数|脚本|单元测试|```|\brefactor\b|\bimplement\b|\brewrite this\b|\bcode\b|\bfunction\b|\btest\b/iu],
  ["design", /设计|架构|方案|取舍|选型|规划|该用|应该用|哪种更|对比一下|\barchitect|\bdesign\b|\bplan\b|trade-?off/iu],
  ["rewrite", /翻译|润色|改写|缩写|总结|摘要|概括|\btranslate\b|\bpolish\b|\bsummar/iu],
  ["explain", /解释|为什么|原理|区别|是什么|怎么理解|讲讲|\bexplain\b|\bwhy\b|\bwhat is\b|\bhow does\b|difference/iu],
];

/** Tokens, not characters: a CJK question is far denser than an English one. */
const SMALL_TOKENS = 24;
const LARGE_TOKENS = 200;

export function classifyQuestion(text: string): QuestionShape {
  const trimmed = text.trim();
  const kind = KIND_PATTERNS.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? "other";
  const tokens = estimateTextTokens(trimmed);
  const size: QuestionSize = tokens <= SMALL_TOKENS ? "small" : tokens >= LARGE_TOKENS ? "large" : "medium";
  return { kind, size };
}

// --- one branch of one race -----------------------------------------------

export interface RaceBranchRecord {
  model: string;
  effort: ReasoningEffort;
  ms: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Estimated USD, absent when the model has no known rates. */
  cost?: number;
  chosen?: boolean;
  failed?: boolean;
}

export interface RaceRecord {
  version: 1;
  at: string;
  kind: QuestionKind;
  size: QuestionSize;
  branches: RaceBranchRecord[];
}

function validBranch(value: unknown): RaceBranchRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.model !== "string" || !value.model) return undefined;
  if (!(REASONING_EFFORTS as readonly unknown[]).includes(value.effort)) return undefined;
  const numbers = ["ms", "outputTokens", "reasoningTokens"] as const;
  if (numbers.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) return undefined;
  const branch: RaceBranchRecord = {
    model: value.model,
    effort: value.effort as ReasoningEffort,
    ms: value.ms as number,
    outputTokens: value.outputTokens as number,
    reasoningTokens: value.reasoningTokens as number,
  };
  if (typeof value.cost === "number" && Number.isFinite(value.cost)) branch.cost = value.cost;
  if (value.chosen === true) branch.chosen = true;
  if (value.failed === true) branch.failed = true;
  return branch;
}

export function parseRaceRecord(value: unknown): RaceRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.at !== "string") return undefined;
  if (typeof value.kind !== "string" || !(value.kind in QUESTION_KIND_LABELS)) return undefined;
  if (value.size !== "small" && value.size !== "medium" && value.size !== "large") return undefined;
  if (!Array.isArray(value.branches)) return undefined;
  const branches = value.branches.flatMap((branch) => {
    const parsed = validBranch(branch);
    return parsed ? [parsed] : [];
  });
  if (branches.length < 2) return undefined;
  return { version: 1, at: value.at, kind: value.kind as QuestionKind, size: value.size, branches };
}

/**
 * Append-only JSONL. A comparison is worth keeping for months and is tiny, so
 * the simplest durable format wins; a corrupt line costs one sample, not the
 * file.
 */
export class RaceLedger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(record: RaceRecord): Promise<void> {
    await ensurePrivateDirectory(dirname(this.path));
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  /** The most recent `limit` records; missing or unreadable file means none. */
  async load(limit = 500): Promise<RaceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const records: RaceRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = parseRaceRecord(JSON.parse(line) as unknown);
        if (record) records.push(record);
      } catch {
        continue;
      }
    }
    return records.slice(-limit);
  }
}

// --- what the records say --------------------------------------------------

/** How narrowly the matching records were selected. */
export type AdviceScope = "kind+size" | "kind" | "all";

export interface EffortAdvice {
  effort: ReasoningEffort;
  /** Races that offered this level and matched the question. */
  samples: number;
  /** How many of those it won. */
  wins: number;
  /** Average USD saved against the level it replaces, when both are priced. */
  saved?: number;
  scope: AdviceScope;
}

/** Enough picks that a preference is a pattern rather than a coincidence. */
const MIN_SAMPLES: Record<AdviceScope, number> = { "kind+size": 3, kind: 4, all: 6 };
/** A level nobody has raced twice cannot be recommended over one that was. */
const MIN_APPEARANCES = 2;

function averageCost(records: RaceRecord[], effort: ReasoningEffort): number | undefined {
  const costs = records.flatMap((record) =>
    record.branches.filter((branch) => branch.effort === effort && branch.cost !== undefined).map((b) => b.cost ?? 0),
  );
  if (costs.length === 0) return undefined;
  return costs.reduce((total, value) => total + value, 0) / costs.length;
}

function adviseFrom(records: RaceRecord[], scope: AdviceScope, current: ReasoningEffort): EffortAdvice | undefined {
  if (records.length < MIN_SAMPLES[scope]) return undefined;
  const tally = new Map<ReasoningEffort, { wins: number; samples: number }>();
  for (const record of records) {
    for (const branch of record.branches) {
      if (branch.failed) continue;
      const entry = tally.get(branch.effort) ?? { wins: 0, samples: 0 };
      entry.samples += 1;
      if (branch.chosen) entry.wins += 1;
      tally.set(branch.effort, entry);
    }
  }
  const ranked = [...tally.entries()]
    .filter(([, entry]) => entry.samples >= MIN_APPEARANCES)
    .map(([effort, entry]) => ({ effort, ...entry, rate: entry.wins / entry.samples }))
    // Ties go to the cheaper level: given equal evidence, paying more for the
    // same win rate is the thing this feature exists to stop.
    .sort((a, b) => b.rate - a.rate || REASONING_EFFORTS.indexOf(a.effort) - REASONING_EFFORTS.indexOf(b.effort));
  const best = ranked[0];
  if (!best || best.wins === 0) return undefined;
  const advice: EffortAdvice = { effort: best.effort, samples: best.samples, wins: best.wins, scope };
  if (best.effort !== current) {
    const from = averageCost(records, current);
    const to = averageCost(records, best.effort);
    if (from !== undefined && to !== undefined && from - to > 0) advice.saved = from - to;
  }
  return advice;
}

/**
 * Which effort this question is worth, judged only by races the user has run.
 *
 * Widens the sample from "this kind of question, this size" outwards, and
 * gives up rather than guessing: with no evidence the configured level stands.
 */
export function recommendEffort(
  records: RaceRecord[],
  shape: QuestionShape,
  current: ReasoningEffort,
): EffortAdvice | undefined {
  const byKind = records.filter((record) => record.kind === shape.kind);
  const bySize = byKind.filter((record) => record.size === shape.size);
  return (
    adviseFrom(bySize, "kind+size", current) ??
    adviseFrom(byKind, "kind", current) ??
    adviseFrom(records, "all", current)
  );
}

/** A count per effort level, ordered low → high → max. */
export type EffortTally = Record<ReasoningEffort, number>;

export interface KindSummary {
  kind: QuestionKind;
  races: number;
  wins: EffortTally;
  appearances: EffortTally;
}

/** Per-kind tally for `/race stats`. */
export function summarize(records: RaceRecord[]): KindSummary[] {
  const empty = (): Record<ReasoningEffort, number> => ({ low: 0, high: 0, max: 0 });
  const byKind = new Map<QuestionKind, KindSummary>();
  for (const record of records) {
    const summary = byKind.get(record.kind) ?? {
      kind: record.kind,
      races: 0,
      wins: empty(),
      appearances: empty(),
    };
    summary.races += 1;
    for (const branch of record.branches) {
      if (branch.failed) continue;
      summary.appearances[branch.effort] += 1;
      if (branch.chosen) summary.wins[branch.effort] += 1;
    }
    byKind.set(record.kind, summary);
  }
  return [...byKind.values()].sort((a, b) => b.races - a.races);
}

// --- command arguments -----------------------------------------------------

export interface RaceBranch {
  model: string;
  effort: ReasoningEffort;
  /** How the branch is named in the table: "max", or "v4-pro@max" when models differ. */
  label: string;
}

export interface RaceArgs {
  branches: RaceBranch[];
  question: string;
  blind: boolean;
  /** `/race stats` asks for the ledger, not for a race. */
  stats: boolean;
}

function isEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Resolves a model word: an alias like `pro` (matched against the recommended
 * ids) or a full id. Anything else is part of the question — a race spec has
 * to be recognisable without eating the first word of "explain this to me".
 */
function resolveModel(word: string): string | undefined {
  const lower = word.toLocaleLowerCase();
  const recommended = RECOMMENDED_MODELS.find(({ id }) => id === lower || id.endsWith(`-${lower}`));
  if (recommended) return recommended.id;
  if (/^deepseek-[a-z0-9][a-z0-9._:-]*$/u.test(lower)) return lower;
  return undefined;
}

/** A leading `low`, `pro`, `pro@max`… branch spec, or undefined when it is not one. */
function parseSpec(token: string, defaults: { model: string; effort: ReasoningEffort }): RaceBranch | undefined {
  const [head = "", tail] = token.split("@", 2);
  if (tail !== undefined) {
    const model = resolveModel(head);
    const effort = tail.toLocaleLowerCase();
    if (!model || !isEffort(effort)) return undefined;
    return { model, effort, label: "" };
  }
  const lower = head.toLocaleLowerCase();
  if (isEffort(lower)) return { model: defaults.model, effort: lower, label: "" };
  const model = resolveModel(lower);
  if (model) return { model, effort: defaults.effort, label: "" };
  return undefined;
}

function labelBranches(branches: RaceBranch[]): RaceBranch[] {
  const sameModel = new Set(branches.map((branch) => branch.model)).size <= 1;
  return branches.map((branch) => ({
    ...branch,
    label: sameModel ? branch.effort : `${branch.model.replace(/^deepseek-/u, "")}@${branch.effort}`,
  }));
}

/**
 * Parses `/race [--blind] [low|pro|pro@max …] <问题>`.
 *
 * Only the leading run of tokens is read as branch specs, and only words that
 * are unmistakably one: an effort level, a known model alias or a `deepseek-*`
 * id. Treating any word as a model would swallow the first word of a question.
 */
export function parseRaceArgs(args: string, defaults: { model: string; effort: ReasoningEffort }): RaceArgs {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 1 && tokens[0]?.toLocaleLowerCase() === "stats") {
    return { branches: [], question: "", blind: false, stats: true };
  }
  const branches: RaceBranch[] = [];
  let blind = false;
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--blind" || token === "-b") {
      blind = true;
      continue;
    }
    const spec = parseSpec(token, defaults);
    if (!spec) break;
    const duplicate = branches.some((branch) => branch.model === spec.model && branch.effort === spec.effort);
    if (!duplicate) branches.push(spec);
  }
  return {
    branches: labelBranches(branches),
    question: tokens.slice(index).join(" "),
    blind,
    stats: false,
  };
}
