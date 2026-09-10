<div align="center">

# 🐋 DeepSeek Blue TUI

**A lightweight terminal chat client for the DeepSeek API**

Streaming Markdown · session workflow · measured cost · managed official Harness

[![CI](https://github.com/Manfredss/deepseek-blue-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/Manfredss/deepseek-blue-tui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-4D6BFE.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-3C873A.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](./tsconfig.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#install)

[简体中文](./README.md) · **English**

<img width="913" alt="DeepSeek Blue TUI startup screen" src="https://github.com/user-attachments/assets/24d79a7f-c292-4174-97d8-e258ff515512" />

</div>

---

> [!NOTE]
> This is an **unofficial community project**, not affiliated with DeepSeek AI or Anthropic. It borrows command conventions from Claude Code but is neither a clone of it nor a full coding agent. For reading and writing files, running commands, calling tools or planning work, use the integrated official DSH.

An unofficial, community-built terminal client for DeepSeek. Streaming chat with real Markdown rendering, a session workflow borrowed from editor-grade tools, honest cost accounting, and managed integration with DeepSeek's own Harness (DSH).

---

## Contents

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Slash commands](#slash-commands) · [Delegating to DSH](#delegating-to-dsh) · [Comparing thinking effort](#comparing-thinking-effort) · [Context cache and cost](#context-cache-and-cost) · [CLI usage](#cli-usage) · [Configuration](#configuration) · [Security](#security) · [Limitations](#limitations) · [Development](#development)

---

## Features

| | |
| --- | --- |
| ⚡ **Streaming chat** | Direct to DeepSeek's OpenAI-compatible API. Defaults to `deepseek-v4-flash`; switch to `deepseek-v4-pro` or any custom model ID. |
| 📝 **Markdown as it streams** | Fenced code gets a language label, a gutter and light tinting. Text appears **as it is generated**, not after each line completes. Code is never truncated or reflowed. |
| 🧠 **Thinking effort** | `/effort [low\|high\|max]` maps to the official `reasoning_effort`; `/thinking` shows or hides the reasoning stream. |
| 🏁 **Effort measured, not guessed** | `/race low max <question>` asks the same question at several efforts in parallel and compares latency, tokens and cost before you keep one. |
| 🤖 **Hand work to an agent** | `/do <task>` passes a distilled version of the conversation to `dsh --profile headless`, which actually edits files and runs commands, then folds the result back into the session. |
| 💰 **Cache-aware cost** | `/cache` shows hit rate and estimated spend. `/compact` and switching model invalidate the whole cached prefix — both say what that will cost **before** asking to continue. |
| 🗂️ **Session workflow** | `/btw` side questions, `/compact` with automatic backup, `/export` to Markdown, `/rewind` to branch, `/search` full-text within a session. |
| ⌨️ **Familiar keys** | <kbd>Tab</kbd> completion, <kbd>Esc</kbd> to interrupt, <kbd>Ctrl</kbd>+<kbd>C</kbd> to clear the line, trailing `\` to continue, <kbd>↑</kbd> for cross-session history. |
| 🔒 **Credentials stay put** | API key stored `0600`, or supplied by environment. DSH child processes never inherit it — the Harness manages its own. |

---

## Install

This project is **not published to npm**. Install the tarball attached to the latest release:

```bash
npm install -g https://github.com/Manfredss/deepseek-blue-tui/releases/latest/download/deepseek-blue-tui.tgz
```

That URL always points at the newest release. To pin a version:

```bash
npm install -g https://github.com/Manfredss/deepseek-blue-tui/releases/download/v0.4.0/deepseek-blue-tui-0.4.0.tgz
```

Uninstall with `npm uninstall -g deepseek-blue-tui`.

Release tarballs are built by the [release workflow](.github/workflows/release.yml) when a tag is pushed: it runs the full test suite, refuses a tag whose name disagrees with `package.json`, and installs the packed tarball into an isolated prefix and runs both binaries — only then does it publish.

Requires **Node.js ≥ 22.19**.

> [!NOTE]
> Do **not** use `npm install -g github:Manfredss/deepseek-blue-tui`. It cannot work on current npm: pacote prepares any git dependency whose `package.json` declares a `build`, `install`, `prepare` or `prepack` script (`pacote/lib/git.js`), and that nested install inherits `npm_config_global` through the environment — so it installs the package globally on top of the bin links the outer install just created and dies with `ENOTDIR`. A release tarball never touches that path.

### From source

```bash
git clone https://github.com/Manfredss/deepseek-blue-tui.git
cd deepseek-blue-tui
npm ci
npm install -g .
```

Or run it without installing: `npm run dev`.

### Installing DSH (optional)

Only needed for `/dsh` and `/do`:

```bash
deepseek dsh install     # or /dsh install inside the TUI
```

This installs the `latest` tag of `@deepseek-ai/dsh` globally. Any `dsh` already on `PATH`, or one pointed to by `DEEPSEEK_DSH_COMMAND`, is reused instead.

---

## Quick start

```bash
deepseek                      # interactive
deepseek "explain this repo"  # one shot
cat notes.md | deepseek       # read the prompt from stdin
```

On first run, `/login` stores an API key, or set `DEEPSEEK_API_KEY`.

There is a neutral alias, **`dstui`**, identical to `deepseek`, for when the name collides with something else on your `PATH`.

---

## Slash commands

| Command | What it does |
| --- | --- |
| `/model [name]` | Pick Flash/Pro from a menu, or pass a custom model ID |
| `/login [browser]` | Store an API key without echoing it, or open the platform page |
| `/logout` | Remove the stored key (an environment variable still applies) |
| `/usage [topup]` | Query balance, then open the usage or top-up page |
| `/clear` | Save the session, clear the screen, start an empty one (alias `/new`) |
| `/resume [id/title]` | Browse or match sessions for this directory (alias `/sessions`) |
| `/rename <title>` | Rename the current session |
| `/thinking [on\|off]` | Show or hide the reasoning stream |
| `/effort [low\|high\|max]` | Set thinking effort |
| `/status` | Model, endpoint, context pressure, tokens, cache, speed, credentials, DSH |
| `/context` | Per-message token audit and a breakdown by role |
| `/cache` | Cache hit rate, reusable prefix, estimated spend |
| `/btw <question>` | Ask once against the current context without recording it |
| `/race [efforts…] <question>` | Run several efforts in parallel and keep one |
| `/compact` | Compress history into one summary (backs up first) |
| `/export` | Write the session out as Markdown |
| `/edit [draft]` | Compose the next message in `$VISUAL`/`$EDITOR` |
| `/attach <path>` | Attach a text file (≤256 KiB, binaries refused) |
| `/rewind [n]` | Branch a new session from an earlier message |
| `/search <text>` | Line-grained full-text search within the session |
| `/do <task>` | Hand a task to the DSH agent (alias `/agent`) |
| `/dsh [action] [port]` | Manage the DSH web backend |
| `/help` · `/exit` | Help; save and quit (alias `/quit`) |

### Keys

<kbd>Enter</kbd> send · trailing `\` continue on the next line · <kbd>Tab</kbd> complete · <kbd>↑</kbd>/<kbd>↓</kbd> history, or move within the command palette · <kbd>Esc</kbd> interrupt a generation · <kbd>Ctrl</kbd>+<kbd>C</kbd> clear the line, twice on an empty prompt to quit · <kbd>Ctrl</kbd>+<kbd>D</kbd> quit · <kbd>Ctrl</kbd>+<kbd>L</kbd> clear the screen

Start a message with `//` to send a literal leading slash.

---

## Delegating to DSH

`/dsh` opens a browser on a *fresh* conversation, which throws away the context you just built. `/do` does the opposite: it passes the distilled conversation to `dsh --profile headless` — which answers one task and exits — and folds the result back in.

```
❯ I think the race is in the inode comparison in touchLock
◆ DeepSeek  (cheap, fast, thinking it through…)

❯ /do fix it per the conclusion above and add a regression test
Hand to DSH
  task     fix it per the conclusion above and add a regression test
  cwd      ~/Documents/Coding/Deepseek TUI
  DSH      /opt/homebrew/bin/dsh (v0.1.1-rc.2)
  context  carrying ~1.2k tokens of recent conversation
DSH will really modify files and run commands here, using its own credentials.
Proceed? [y/N] ›
```

The split is **a cheap thinking layer and an expensive doing layer, sharing context**.

- It always confirms, and says plainly that files will change.
- The task is passed as a **single argv element**, so shell metacharacters stay inert.
- `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` are scrubbed from the child: the Harness is a separate trust boundary with its own credentials.
- <kbd>Esc</kbd> interrupts; there is a 15-minute timeout.
- The outcome is recorded with a `[DSH 执行结果]` prefix, so its provenance is never ambiguous.

---

## Comparing thinking effort

Nothing published says when `max` earns its latency. This client already measures tokens, time and cost exactly, so it can answer the question for *your* kind of question:

```
❯ /race low max what data structure should this cache use
Comparing low / max
  effort  time     out     thinking  cost       preview
  low     1.2s     120     0         ≈$0.0004   Just use a Map.
  max     18.7s    1.9k    5.2k      ≈$0.0093   Three cases to separate: …
Keep which one? (the rest are discarded)
```

Discarded branches are **still billed**, so all of them count toward session usage — and the UI says so.

---

## Live usage and balance

Each turn ends with what it actually cost and what is left:

```
30,000 in · 2,000 out · cache 28k · 3.4s · 588 tok/s · ≈$0.0039 · 余额 ≈42.47 CNY
```

The balance is **never on the request path**: fetched once at startup and refreshed in the background after a turn, so a slow balance endpoint cannot hold up your next message. Between refreshes it is decremented locally by the estimated cost, which is why it moves every turn — a `≈` marks a figure carried forward that way, and its absence means it was just read from the API.

A failed lookup never disturbs the session; the figure simply stops being shown.

## Context cache and cost

DeepSeek's context cache is automatic and prefix-based, and only serves a **fully matching** prefix. So anything that rewrites early history invalidates all of it. `/cache` shows where you stand:

```
Context cache
  hit rate   91.7% · hit 33k · miss 3.0k
  reusable   12k tokens (next turn hits, if early history is left alone)
  saved      ≈$0.014 (versus paying miss rate throughout)
  session    ≈$0.0053 · estimate, peak pricing, override in config.json
```

`/compact` and switching model both discard the whole prefix, and each quantifies that before asking to continue. `/rewind` only truncates the tail, so its prefix survives — no warning, because there is nothing to warn about.

Costs use DeepSeek's published USD/1M-token rates at the **peak** figure, so an estimate never understates. Override per model in `config.json`:

```json
{
  "pricing": {
    "deepseek-v4-flash": { "cacheHit": 0.007, "cacheMiss": 0.22, "output": 0.66 }
  }
}
```

A model with no known rate shows tokens rather than an invented price.

---

## CLI usage

```bash
deepseek                            # interactive
deepseek "question"                 # one shot
deepseek --model deepseek-v4-pro    # pick a model
deepseek --effort max               # thinking effort
deepseek --continue                 # resume the latest session here
deepseek resume [ID]                # resume a specific session
deepseek login                      # configure the API key
deepseek usage                      # balance, then the usage page
deepseek sessions                   # list local sessions
deepseek dsh [install|start|open|status|stop|logs|restart]
```

Options: `-m/--model`, `--effort`, `-c/--continue`, `-r/--resume [ID]`, `--endpoint <url>`, `--thinking`, `--no-logo`, `--no-color`, `-h/--help`, `-V/--version`.

---

## Configuration

Data lives under `$XDG_CONFIG_HOME/deepseek-tui` (or `~/.config/deepseek-tui`; `%APPDATA%\deepseek-tui` on Windows). Override with `DEEPSEEK_TUI_HOME`.

| Path | Contents |
| --- | --- |
| `config.json` | Model, endpoint, API key, effort, context limit, pricing overrides (`0600`) |
| `sessions/` | One JSON file per session, isolated by working directory |
| `exports/` | `/export` and `/compact` backups |
| `history` | Cross-session input history (`0600`, 500 entries) |
| `dsh/` | DSH state and rotated logs |

Environment: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_DSH_COMMAND`, `DEEPSEEK_TUI_HOME`, `NO_COLOR`.

---

## Security

- The API key is written `0600` and shown masked; input is never echoed.
- History skips blank lines, duplicates, multi-line pastes and anything resembling a key.
- Message content is sanitised before display, so a reply cannot emit escape sequences that repaint your terminal.
- DSH logs are redacted for `sk-` keys, Bearer tokens and `Authorization` headers.
- DSH child processes never inherit the chat client's credentials.
- Session files are locked; a second terminal opening the same session becomes read-only rather than overwriting it.

---

## Limitations

- Interactive mode needs a TTY.
- Token counts are **estimates** (CJK ≈ 1 token/char, ASCII ≈ 4 chars/token) except where the API reports real usage.
- Costs are estimates at peak rates and may drift from published pricing; override them in config.
- DSH is a developer preview upstream and may change without notice.
- The DSH background process is not a service; it does not survive a reboot.

---

## Development

```bash
npm ci
npm run dev            # run from source
npm run check          # typecheck + tests
npm test
npm run build
```

CI covers Node 22/24 on Ubuntu, macOS and Windows, and additionally packs the real tarball, installs it into an isolated prefix, and runs both binaries — the same artefact published to releases.

Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Design notes and the reasoning behind several decisions are in [RESEARCH.md](RESEARCH.md); the change history is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
