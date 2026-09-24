import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  classifyQuestion,
  parseRaceArgs,
  RaceLedger,
  recommendEffort,
  summarize,
  type EffortTally,
  type RaceRecord,
} from "../src/race.js";
import type { ReasoningEffort } from "../src/types.js";

/**
 * The ledger behind `/effort auto`. Its whole value is that the advice can be
 * traced back to races the user actually judged, so the rules that turn picks
 * into a recommendation are pinned down here.
 */

const DEFAULTS = { model: "deepseek-v4-flash", effort: "high" as ReasoningEffort };

function record(
  kind: RaceRecord["kind"],
  size: RaceRecord["size"],
  winner: ReasoningEffort,
  levels: ReasoningEffort[] = ["low", "max"],
  costs: Partial<Record<ReasoningEffort, number>> = { low: 0.001, max: 0.01 },
): RaceRecord {
  return {
    version: 1,
    at: "2026-09-01T00:00:00.000Z",
    kind,
    size,
    branches: levels.map((effort) => ({
      model: "deepseek-v4-flash",
      effort,
      ms: 1_000,
      outputTokens: 100,
      reasoningTokens: 10,
      ...(costs[effort] !== undefined ? { cost: costs[effort] as number } : {}),
      ...(effort === winner ? { chosen: true as const } : {}),
    })),
  };
}

test("a question is classified by intent before length", () => {
  // "为什么会报错" is a debugging question, not a request to explain a concept.
  assert.equal(classifyQuestion("为什么会报错？").kind, "debug");
  assert.equal(classifyQuestion("写个函数把它拍平").kind, "code");
  assert.equal(classifyQuestion("解释一下 MVCC 的原理").kind, "explain");
  assert.equal(classifyQuestion("把这段翻译成英文").kind, "rewrite");
  assert.equal(classifyQuestion("这里该用哪种数据结构？给个方案").kind, "design");
  assert.equal(classifyQuestion("嗯").kind, "other");

  assert.equal(classifyQuestion("嗯？").size, "small");
  assert.equal(classifyQuestion("字".repeat(400)).size, "large");
});

test("/race arguments read branch specs only from the leading tokens", () => {
  const efforts = parseRaceArgs("low max 该怎么做", DEFAULTS);
  assert.deepEqual(efforts.branches.map((branch) => branch.label), ["low", "max"]);
  assert.equal(efforts.question, "该怎么做");
  assert.equal(efforts.blind, false);

  // Models can race too, and then the label has to say which model.
  const models = parseRaceArgs("flash pro 谁更合适", DEFAULTS);
  assert.deepEqual(models.branches.map((branch) => branch.model), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(models.branches.map((branch) => branch.label), ["v4-flash@high", "v4-pro@high"]);

  const mixed = parseRaceArgs("pro@max low 想一想", DEFAULTS);
  assert.deepEqual(
    mixed.branches.map((branch) => `${branch.model}/${branch.effort}`),
    ["deepseek-v4-pro/max", "deepseek-v4-flash/low"],
  );

  // A model id inside the question is part of the question, not a branch.
  const question = parseRaceArgs("low 解释 deepseek-v4-pro 和 flash 的区别", DEFAULTS);
  assert.equal(question.branches.length, 1);
  assert.equal(question.question, "解释 deepseek-v4-pro 和 flash 的区别");

  assert.equal(parseRaceArgs("--blind low max 问题", DEFAULTS).blind, true);
  assert.equal(parseRaceArgs("stats", DEFAULTS).stats, true);
  assert.equal(parseRaceArgs("low low max 问题", DEFAULTS).branches.length, 2, "duplicate specs collapse");
  assert.deepEqual(parseRaceArgs("直接问一句", DEFAULTS).branches, [], "a plain question races nothing by itself");
});

test("the ledger survives corrupt lines and a missing file", async (t: TestContext) => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-race-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new RaceLedger(join(home, "races.jsonl"));

  assert.deepEqual(await ledger.load(), [], "no file yet means no evidence");
  await ledger.append(record("code", "small", "low"));
  await ledger.append(record("debug", "medium", "max"));
  assert.equal((await ledger.load()).length, 2);

  await writeFile(ledger.path, `${JSON.stringify(record("code", "small", "low"))}\nnot json\n{"version":2}\n`);
  const survivors = await ledger.load();
  assert.equal(survivors.length, 1, "a corrupt line costs one sample, not the file");
});

test("advice needs several races before it overrides the configured level", () => {
  const two = [record("code", "small", "low"), record("code", "small", "low")];
  assert.equal(recommendEffort(two, { kind: "code", size: "small" }, "max"), undefined);

  const three = [...two, record("code", "small", "max")];
  const advice = recommendEffort(three, { kind: "code", size: "small" }, "max");
  assert.equal(advice?.effort, "low");
  assert.equal(advice?.wins, 2);
  assert.equal(advice?.samples, 3);
  assert.equal(advice?.scope, "kind+size");
  assert.ok((advice?.saved ?? 0) > 0, "the cheaper level reports what it saves");
});

test("advice widens to the whole ledger before giving up, and ties go to the cheaper level", () => {
  // Nothing of this kind and size, but plenty of evidence overall.
  const spread = [
    record("debug", "large", "low"),
    record("debug", "large", "low"),
    record("explain", "medium", "low"),
    record("explain", "medium", "low"),
    record("rewrite", "small", "low"),
    record("rewrite", "small", "low"),
  ];
  assert.equal(recommendEffort(spread, { kind: "code", size: "small" }, "max")?.scope, "all");

  const tied = [
    record("code", "small", "low", ["low", "high"]),
    record("code", "small", "high", ["low", "high"]),
    record("code", "small", "low", ["low", "high"]),
    record("code", "small", "high", ["low", "high"]),
  ];
  assert.equal(recommendEffort(tied, { kind: "code", size: "small" }, "max")?.effort, "low");
});

test("a level nobody raced twice cannot be recommended, and no winner means no advice", () => {
  const thin = [
    record("code", "small", "low", ["low", "max"]),
    record("code", "small", "low", ["low", "max"]),
    // `high` appears once and wins it: one race is not a pattern.
    record("code", "small", "high", ["high", "max"]),
  ];
  assert.equal(recommendEffort(thin, { kind: "code", size: "small" }, "max")?.effort, "low");

  const undecided: RaceRecord[] = [1, 2, 3].map(() => ({
    ...record("code", "small", "low"),
    branches: record("code", "small", "low").branches.map(({ chosen: _chosen, ...branch }) => branch),
  }));
  assert.equal(recommendEffort(undecided, { kind: "code", size: "small" }, "high"), undefined);
});

test("summarize tallies wins against appearances per kind", () => {
  const summaries = summarize([
    record("code", "small", "low"),
    record("code", "medium", "max"),
    record("debug", "small", "max"),
  ]);
  assert.deepEqual(summaries.map((summary) => summary.kind), ["code", "debug"]);
  const code = summaries[0] as { wins: EffortTally; appearances: EffortTally; races: number };
  assert.equal(code.races, 2);
  assert.equal(code.wins.low, 1);
  assert.equal(code.wins.max, 1);
  assert.equal(code.appearances.low, 2);
});
