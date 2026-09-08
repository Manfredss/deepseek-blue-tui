function wrap(enabled, open, close) {
    return (value) => (enabled ? `${open}${value}${close}` : value);
}
export function colorEnabled(stream = process.stdout, env = process.env) {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "")
        return false;
    if (env.FORCE_COLOR === "0")
        return false;
    if (env.FORCE_COLOR !== undefined)
        return true;
    if (env.TERM === "dumb")
        return false;
    return Boolean(stream.isTTY);
}
function colorLevel(env) {
    const colorTerm = env.COLORTERM?.toLocaleLowerCase();
    const term = env.TERM?.toLocaleLowerCase() ?? "";
    if (colorTerm === "truecolor" || colorTerm === "24bit" || term.includes("truecolor") || term.includes("direct")) {
        return "truecolor";
    }
    if (term.includes("256color") || env.TERM_PROGRAM)
        return "ansi256";
    return "ansi16";
}
export function createTheme(enabled = colorEnabled(), env = process.env) {
    const level = colorLevel(env);
    const blue = level === "truecolor" ? "\u001b[38;2;77;107;254m" : level === "ansi256" ? "\u001b[38;5;63m" : "\u001b[94m";
    const brightBlue = level === "truecolor" ? "\u001b[38;2;111;145;255m" : level === "ansi256" ? "\u001b[38;5;69m" : "\u001b[94m";
    const muted = level === "truecolor" ? "\u001b[38;2;128;138;157m" : level === "ansi256" ? "\u001b[38;5;245m" : "\u001b[90m";
    return {
        enabled,
        blue: wrap(enabled, blue, "\u001b[0m"),
        brightBlue: wrap(enabled, brightBlue, "\u001b[0m"),
        muted: wrap(enabled, muted, "\u001b[0m"),
        bold: wrap(enabled, "\u001b[1m", "\u001b[22m"),
        red: wrap(enabled, "\u001b[31m", "\u001b[39m"),
        yellow: wrap(enabled, "\u001b[33m", "\u001b[39m"),
        green: wrap(enabled, "\u001b[32m", "\u001b[39m"),
        cyan: wrap(enabled, "\u001b[36m", "\u001b[39m"),
    };
}
export function clearCurrentLine(stream = process.stdout) {
    if (stream.isTTY)
        stream.write("\r\u001b[2K");
}
