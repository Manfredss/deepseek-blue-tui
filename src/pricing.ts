import type { ChatMessage, TokenUsage } from "./types.js";
import { estimateTokens } from "./session-store.js";
import { isRecord } from "./fs-utils.js";

/**
 * Cost estimation for DeepSeek usage.
 *
 * Published rates go stale — that is exactly the trap the hardcoded DSH
 * version fell into — so these are only *defaults*, every one of them is
 * overridable from config.json, and every figure the client prints is marked
 * as an estimate. DeepSeek also bills a lower off-peak rate; the defaults use
 * the higher (peak) rate so an estimate is never an understatement.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing (USD per 1M tokens).
 */

export interface ModelPricing {
  /** USD per 1M input tokens served from the context cache. */
  cacheHit: number;
  /** USD per 1M input tokens that missed the cache. */
  cacheMiss: number;
  /** USD per 1M output tokens (reasoning tokens bill as output). */
  output: number;
}

export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  "deepseek-v4-flash": { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  "deepseek-v4-pro": { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
};

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parses a user-supplied `pricing` map, dropping anything malformed. */
export function normalizePricing(value: unknown): Record<string, ModelPricing> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, ModelPricing> = {};
  for (const [model, rates] of Object.entries(value)) {
    if (!isRecord(rates)) continue;
    if (!validRate(rates.cacheHit) || !validRate(rates.cacheMiss) || !validRate(rates.output)) continue;
    result[model] = { cacheHit: rates.cacheHit, cacheMiss: rates.cacheMiss, output: rates.output };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Rates for a model, or undefined when none are known — in which case the
 * caller must show token counts instead of inventing a price.
 */
export function pricingFor(
  model: string,
  overrides?: Record<string, ModelPricing>,
): ModelPricing | undefined {
  return overrides?.[model] ?? DEFAULT_PRICING[model];
}

const PER_MILLION = 1_000_000;

/** Estimated USD for one turn's usage. Reasoning tokens bill as output. */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing): number {
  // The API reports cache hit/miss as a split of prompt tokens. When a server
  // omits the split, fall back to charging every prompt token at miss rate.
  const split = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
  const hit = split > 0 ? usage.promptCacheHitTokens : 0;
  const miss = split > 0 ? usage.promptCacheMissTokens : usage.promptTokens;
  return (
    (hit * pricing.cacheHit + miss * pricing.cacheMiss + usage.completionTokens * pricing.output) / PER_MILLION
  );
}

/** `$0.0042` / `$1.37` — always prefixed with ≈ by callers. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "—";
  if (usd === 0) return "$0";
  // Rounding a real charge down to "$0.0000" reads as free, which it is not.
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export interface CacheReport {
  hitTokens: number;
  missTokens: number;
  /** 0-100, or undefined when no prompt tokens have been billed yet. */
  hitRate: number | undefined;
  /** USD the cache has saved so far versus paying miss rate throughout. */
  saved: number | undefined;
}

export function cacheReport(usage: TokenUsage, pricing?: ModelPricing): CacheReport {
  const total = usage.promptCacheHitTokens + usage.promptCacheMissTokens;
  const report: CacheReport = {
    hitTokens: usage.promptCacheHitTokens,
    missTokens: usage.promptCacheMissTokens,
    hitRate: total > 0 ? (usage.promptCacheHitTokens / total) * 100 : undefined,
    saved: undefined,
  };
  if (pricing && usage.promptCacheHitTokens > 0) {
    report.saved = (usage.promptCacheHitTokens * (pricing.cacheMiss - pricing.cacheHit)) / PER_MILLION;
  }
  return report;
}

/**
 * Tokens of conversation prefix that a next request could plausibly serve from
 * cache. DeepSeek caches on exact prefix match, so this is everything already
 * sent in an earlier request — i.e. the history minus nothing, since each turn
 * resends the whole conversation.
 *
 * This is an upper bound: the cache expires on its own after hours to days,
 * and the client cannot see whether a given prefix is still resident.
 */
export function cachedPrefixTokens(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  return estimateTokens(messages);
}

export interface PrefixLossEstimate {
  tokens: number;
  /** Extra USD the next request costs because the prefix has to be re-read. */
  cost: number | undefined;
}

/**
 * What rewriting the conversation prefix costs. Used to warn before actions
 * that change early history — the cache only serves a *fully* matching prefix,
 * so rewriting any of it forces the next request to pay miss rate for all of
 * the replacement.
 */
export function prefixLoss(messages: ChatMessage[], pricing?: ModelPricing): PrefixLossEstimate {
  const tokens = cachedPrefixTokens(messages);
  const estimate: PrefixLossEstimate = { tokens, cost: undefined };
  if (pricing && tokens > 0) {
    estimate.cost = (tokens * (pricing.cacheMiss - pricing.cacheHit)) / PER_MILLION;
  }
  return estimate;
}
