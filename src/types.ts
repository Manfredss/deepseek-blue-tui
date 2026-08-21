export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  reasoningContent?: string;
  createdAt: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  reasoningTokens: number;
}

export interface Session {
  version: 1;
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  usage: TokenUsage;
  /** Wall-clock duration of the most recent completed generation, in ms. */
  lastTurnMs?: number;
  /** Completion tokens of the most recent completed generation (for TPS). */
  lastCompletionTokens?: number;
}

export type ReasoningEffort = "low" | "high" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "high", "max"] as const;

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "快速响应，较少推理（适合简单任务）",
  high: "默认档，深度思考",
  max: "极限推理（更慢、消耗更多 Token）",
};

export interface AppConfig {
  version: 1;
  model: string;
  baseUrl: string;
  apiKey?: string;
  showReasoning: boolean;
  dshPort: number;
  contextLimitTokens: number;
  /** DeepSeek V4 thinking effort (OpenAI format: low/high/max). */
  effort: ReasoningEffort;
}

export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  reasoningTokens: 0,
};

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  showReasoning: false,
  dshPort: 3080,
  contextLimitTokens: 131_072,
  effort: "high",
};

export const RECOMMENDED_MODELS = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "快速、低成本，适合作为默认模型",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "能力更强，适合复杂任务",
  },
] as const;
