export interface Theme {
  enabled: boolean;
  blue: (value: string) => string;
  brightBlue: (value: string) => string;
  muted: (value: string) => string;
  bold: (value: string) => string;
  red: (value: string) => string;
  yellow: (value: string) => string;
  green: (value: string) => string;
  cyan: (value: string) => string;
}

function wrap(enabled: boolean, open: string, close: string): (value: string) => string {
  return (value: string) => (enabled ? `${open}${value}${close}` : value);
}

export function colorEnabled(
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return Boolean(stream.isTTY);
}

export function createTheme(enabled = colorEnabled()): Theme {
  return {
    enabled,
    blue: wrap(enabled, "\u001b[38;2;77;107;254m", "\u001b[0m"),
    brightBlue: wrap(enabled, "\u001b[38;2;111;145;255m", "\u001b[0m"),
    muted: wrap(enabled, "\u001b[38;2;128;138;157m", "\u001b[0m"),
    bold: wrap(enabled, "\u001b[1m", "\u001b[22m"),
    red: wrap(enabled, "\u001b[31m", "\u001b[39m"),
    yellow: wrap(enabled, "\u001b[33m", "\u001b[39m"),
    green: wrap(enabled, "\u001b[32m", "\u001b[39m"),
    cyan: wrap(enabled, "\u001b[36m", "\u001b[39m"),
  };
}

export function clearCurrentLine(stream: NodeJS.WriteStream = process.stdout): void {
  if (stream.isTTY) stream.write("\r\u001b[2K");
}
