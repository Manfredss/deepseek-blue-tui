import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG, REASONING_EFFORTS } from "./types.js";
import { isRecord, writeJsonAtomic } from "./fs-utils.js";
import { normalizePricing } from "./pricing.js";
export function resolveAppHome(env = process.env) {
    if (env.DEEPSEEK_TUI_HOME?.trim())
        return resolve(env.DEEPSEEK_TUI_HOME.trim());
    if (platform() === "win32" && env.APPDATA?.trim()) {
        return join(env.APPDATA, "deepseek-tui");
    }
    if (env.XDG_CONFIG_HOME?.trim())
        return join(env.XDG_CONFIG_HOME, "deepseek-tui");
    return join(homedir(), ".config", "deepseek-tui");
}
function validPort(value) {
    return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535;
}
function validContextLimit(value) {
    return Number.isInteger(value) && Number(value) >= 4_096 && Number(value) <= 1_048_576;
}
export function isValidEffort(value) {
    return typeof value === "string" && REASONING_EFFORTS.includes(value);
}
export function isValidBaseUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
export function normalizeConfig(value) {
    if (!isRecord(value))
        return { ...DEFAULT_CONFIG };
    const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : DEFAULT_CONFIG.model;
    const candidateUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/+$/, "") : "";
    const baseUrl = isValidBaseUrl(candidateUrl) ? candidateUrl : DEFAULT_CONFIG.baseUrl;
    const config = {
        version: 1,
        model,
        baseUrl,
        showReasoning: typeof value.showReasoning === "boolean" ? value.showReasoning : DEFAULT_CONFIG.showReasoning,
        dshPort: validPort(value.dshPort) ? value.dshPort : DEFAULT_CONFIG.dshPort,
        contextLimitTokens: validContextLimit(value.contextLimitTokens)
            ? value.contextLimitTokens
            : DEFAULT_CONFIG.contextLimitTokens,
        effort: isValidEffort(value.effort) ? value.effort : DEFAULT_CONFIG.effort,
    };
    if (typeof value.apiKey === "string" && value.apiKey.trim())
        config.apiKey = value.apiKey.trim();
    const pricing = normalizePricing(value.pricing);
    if (pricing)
        config.pricing = pricing;
    return config;
}
export class ConfigStore {
    home;
    configPath;
    constructor(home = resolveAppHome()) {
        this.home = home;
        this.configPath = join(home, "config.json");
    }
    async load() {
        try {
            const raw = await readFile(this.configPath, "utf8");
            return normalizeConfig(JSON.parse(raw));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { ...DEFAULT_CONFIG };
            if (error instanceof SyntaxError) {
                throw new Error(`配置文件格式无效：${this.configPath}`, { cause: error });
            }
            throw error;
        }
    }
    async save(config) {
        await writeJsonAtomic(this.configPath, normalizeConfig(config));
    }
    runtime(config, env = process.env) {
        const runtime = { ...config };
        if (env.DEEPSEEK_API_KEY?.trim())
            runtime.apiKey = env.DEEPSEEK_API_KEY.trim();
        if (env.DEEPSEEK_BASE_URL?.trim()) {
            const candidate = env.DEEPSEEK_BASE_URL.trim().replace(/\/+$/, "");
            if (!isValidBaseUrl(candidate))
                throw new Error("DEEPSEEK_BASE_URL 必须是有效的 http(s) URL");
            runtime.baseUrl = candidate;
        }
        return runtime;
    }
}
export function maskApiKey(value) {
    if (!value)
        return "未配置";
    if (value.length <= 10)
        return `${value.slice(0, 3)}••••`;
    return `${value.slice(0, 5)}••••${value.slice(-4)}`;
}
