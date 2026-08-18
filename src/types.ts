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
}

export interface AppConfig {
  version: 1;
  model: string;
  baseUrl: string;
  apiKey?: string;
  showReasoning: boolean;
  dshPort: number;
  contextLimitTokens: number;
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
