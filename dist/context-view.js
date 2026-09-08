import { formatCompactTokens } from "./session-tools.js";
import { clipToWidth, padToWidth, shortenPath } from "./text-width.js";
function safePercent(estimated, limit) {
    if (!Number.isFinite(estimated) || !Number.isFinite(limit) || limit <= 0)
        return undefined;
    return Math.max(0, Math.min(100, (estimated / limit) * 100));
}
function percentText(theme, estimated, limit) {
    const percent = safePercent(estimated, limit);
    if (percent === undefined)
        return "≈–%";
    const value = `≈${Math.round(percent).toLocaleString()}%`;
    if (percent >= 100)
        return theme.red(value);
    if (percent >= 80)
        return theme.yellow(value);
    return value;
}
function accessText(readOnly) {
    return readOnly ? "RO" : "RW";
}
function reasoningText(showReasoning) {
    return `reasoning ${showReasoning ? "shown" : "hidden"}`;
}
function apiText(configured) {
    return configured ? "API ready" : "API missing";
}
/** One-line context HUD: model, estimated pressure, access mode, reasoning, API. */
export function renderContextHud(theme, state, options) {
    const columns = Number.isFinite(options.columns) ? Math.max(16, Math.floor(options.columns)) : 78;
    const full = [
        state.model,
        `ctx ${percentText(theme, state.estimatedTokens, state.limitTokens)} (${formatCompactTokens(state.estimatedTokens)}/${formatCompactTokens(state.limitTokens)})`,
        accessText(state.readOnly),
        reasoningText(state.showReasoning),
        apiText(state.apiKeyConfigured),
    ].join(" · ");
    return clipToWidth(full, columns);
}
const BAR_WIDTH = 20;
const LABEL_WIDTH = 8;
/** Proportional block bar tinted by pressure: blue → yellow → red. */
export function renderPressureBar(theme, percent, width = BAR_WIDTH) {
    const used = percent === undefined ? 0 : Math.min(width, Math.round((percent / 100) * width));
    const filled = "█".repeat(used);
    const empty = "░".repeat(Math.max(0, width - used));
    const tint = percent !== undefined && percent >= 100 ? theme.red : percent !== undefined && percent >= 80 ? theme.yellow : theme.blue;
    return `${tint(filled)}${theme.muted(empty)}`;
}
function row(theme, label, value) {
    return `${theme.muted(padToWidth(label, LABEL_WIDTH))}  ${value}`;
}
/** Multi-line context report: token accounting, cache, access, and cwd. */
export function renderContextReport(theme, state, options) {
    const columns = Number.isFinite(options.columns) ? Math.max(16, Math.floor(options.columns)) : 78;
    const percent = safePercent(state.estimatedTokens, state.limitTokens);
    const bar = renderPressureBar(theme, percent);
    const lines = [
        theme.bold("上下文报告"),
        row(theme, "上下文", `${percentText(theme, state.estimatedTokens, state.limitTokens)} ${bar} ${formatCompactTokens(state.estimatedTokens)}/${formatCompactTokens(state.limitTokens)} tokens（估算）`),
        row(theme, "模型", state.model),
        row(theme, "消息", `${state.messageCount.toLocaleString()} 条`),
        row(theme, "思考过程", `${state.showReasoning ? "显示" : "隐藏"}（${reasoningText(state.showReasoning)}）`),
        row(theme, "会话状态", `${accessText(state.readOnly)}${state.readOnly ? "（只读：消息不会保存）" : "（可写）"}`),
        row(theme, "凭据", `${apiText(state.apiKeyConfigured)}${state.apiKeyConfigured ? "（已配置）" : "（未配置）"}`),
        row(theme, "累计", `${state.usage.totalTokens.toLocaleString()} tokens（输入 ${state.usage.promptTokens.toLocaleString()} · 输出 ${state.usage.completionTokens.toLocaleString()} · 思考 ${state.usage.reasoningTokens.toLocaleString()}）`),
        row(theme, "缓存", `命中 ${state.usage.promptCacheHitTokens.toLocaleString()} · 未命中 ${state.usage.promptCacheMissTokens.toLocaleString()}`),
        row(theme, "工作目录", shortenPath(state.cwd, Math.max(8, columns - LABEL_WIDTH - 2), state.home)),
    ];
    if (percent === undefined) {
        lines.push(theme.yellow("注意：contextLimitTokens 无效，无法计算上下文占用比例"));
    }
    return lines.map((line) => clipToWidth(line, columns)).join("\n");
}
