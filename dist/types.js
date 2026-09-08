export const REASONING_EFFORTS = ["low", "high", "max"];
export const REASONING_EFFORT_LABELS = {
    low: "快速响应，较少推理（适合简单任务）",
    high: "默认档，深度思考",
    max: "极限推理（更慢、消耗更多 Token）",
};
export const EMPTY_USAGE = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    reasoningTokens: 0,
};
export const DEFAULT_CONFIG = {
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
];
