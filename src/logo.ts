import type { Theme } from "./theme.js";

const WHALE = String.raw`
                            ▄▄▄▄▄▄▄
                    ▄▄████████████████▄▄
                ▄████▀▀            ▀▀████▄
      ▄▄       ███▀                     ▀██▄
   ▄██████▄▄  ███       ▄▄                 ██
  ███▀  ▀███████        ▀▀                 ██▌
  ▀██▄      ▀███                  ●        ███
    ▀████▄▄    ▀██▄                    ▄▄████▀
       ▀▀████████████▄▄▄▄▄▄▄▄▄▄▄████████▀▀
               ▀▀██████████████▀▀   ▀██▄
                    ▀██▄   ▀██▄       ▀██▄
                      ▀██▄▄  ▀██▄▄▄▄▄████▀
                         ▀▀██████████▀▀
`;

export function renderLogo(theme: Theme): string {
  const title = `${theme.bold("DeepSeek")} ${theme.muted("Terminal")}`;
  return `${theme.blue(WHALE)}\n                       ${title}\n`;
}
