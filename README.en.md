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

[Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Slash commands](#slash-commands) · [Delegating to DSH](#delegating-to-dsh) · [Comparing thinking effort](#comparing-thinking-effort) · [Finishing and steering an answer](#finishing-and-steering-an-answer) · [Code blocks as artifacts](#code-blocks-as-artifacts) · [Context cache and cost](#context-cache-and-cost) · [CLI usage](#cli-usage) · [Configuration](#configuration) · [Security](#security) · [Limitations](#limitations) · [Development](#development)

---

## Features

| | |
| --- | --- |
| ⚡ **Streaming chat** | Direct to DeepSeek's OpenAI-compatible API. Defaults to `deepseek-v4-flash`; switch to `deepseek-v4-pro` or any custom model ID. |
| 📝 **Markdown as it streams** | Fenced code gets a language label, a gutter and light tinting. Text appears **as it is generated**, not after each line completes. Code is never truncated or reflowed. |
| 🧠 **Thinking effort** | `/effort [low\|high\|max]` maps to the official `reasoning_effort`; `/thinking` shows or hides the reasoning stream. |
| 🏁 **Effort measured, then learned** | `/race low max <question>` compares latency, tokens and cost across efforts (or models) before you keep one — and every verdict is filed, so `/effort auto` can pick the level for each question and show its evidence. |
| ⏭️ **Finish and steer answers** | `/continue` completes an interrupted reply through the official beta prefix completion instead of paying for the whole thinking pass again; `/prefill ```python` makes the answer open with code and nothing else. |
| 📦 **Code blocks as artifacts** | Blocks in a reply are numbered: `/copy` to the clipboard (OSC 52 when there is no local tool), `/save` to a file, `/diff` against the file you attached. |
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
| `/effort [low\|high\|max\|auto]` | Set thinking effort; `auto` picks it per question from the `/race` ledger |
| `/status` | Model, endpoint, context pressure, tokens, cache, speed, credentials, DSH |
| `/context` | Per-message token audit and a breakdown by role |
| `/cache` | Cache hit rate, reusable prefix, estimated spend |
| `/btw <question>` | Ask once against the current context without recording it |
| `/race [branches…] <question>` | Run several efforts or models in parallel and keep one (`--blind`, `stats`) |
| `/continue` | Finish the reply that was interrupted, without re-thinking it |
| `/prefill <text>` | Make the next answer start with this text (one turn only) |
| `/compact` | Compress history into one summary (backs up first) |
| `/export` | Write the session out as Markdown |
| `/edit [draft]` | Compose the next message in `$VISUAL`/`$EDITOR` |
| `/attach <path>` | Attach a text file (≤256 KiB, binaries refused) |
| `/copy [n]` | Copy a code block from the reply to the clipboard |
| `/save [n] <path>` | Write a code block to a file (confirms before overwriting) |
| `/diff [n] [path]` | Compare a code block against the file you attached |
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

Models can race too: `/race flash pro <question>`, or `/race pro@max low <question>`. Only effort names, known model aliases and `deepseek-*` ids count as branches — anything else is the question itself. `/race --blind` hides which branch is which (and shuffles the rows) until after you pick, so "the slow expensive one" cannot give itself away.

**Every verdict is filed.** The branch you keep is a labelled sample of "for this kind of question, that effort was worth its price", so it goes into `races.jsonl` with the question's kind and size and each branch's time, tokens and cost. `/race stats` shows the tally, and `/effort auto` uses it:

```
❯ write a function that flattens this config
auto effort: 写代码 · 5 races, low won 4 → low this turn · saves ≈$0.0038
```

The rules stay conservative: with fewer than three comparable races, or a level raced only once, it says it has no basis and keeps your configured level; equal win rates go to the cheaper level; a level never raced is never recommended, and no saving is quoted unless both sides were priced.

---

## Finishing and steering an answer

Both use the official beta [prefix completion](https://api-docs.deepseek.com/guides/chat_prefix_completion): a trailing assistant message is treated as the *start* of the answer rather than a finished turn.

`/continue` finishes a reply that <kbd>Esc</kbd> cut off. The half already generated was always kept; until now the only way to get the rest was to ask again and pay for the entire thinking pass a second time. The screen redraws the answer as one piece, and the session still holds one message, not two.

`/prefill <text>` decides how the next answer opens:

```bash
/prefill ```python     # start inside a code fence, stop at its close — code only
/prefill 结论：         # skip the preamble, answer with the conclusion
/prefill off           # cancel
```

It applies to **one** turn. A prefill that quietly shaped every later answer would be a hidden mode; the pending one is shown in `/status`. The closing fence the stop sequence removes is restored, so exported Markdown is never left half-open.

> [!NOTE]
> Prefix completion is a beta feature served only from the official `/beta` path. A custom OpenAI-compatible gateway is called exactly as configured — inventing a `/beta` route would turn a working endpoint into a 404 — with a note that it may not support the feature. Failures are reported, never silently downgraded.

---

## Code blocks as artifacts

For a client whose main use is programming questions, the sharpest edge was that code arrived and then had to be selected with a mouse. Fenced blocks now carry a number (`┌─ [1] python`):

```bash
/copy            # the source block of this answer
/copy 1          # by number
/save 1 out.py   # write it out (confirms before overwriting)
/diff 1          # against the file you attached
```

With no number it is **not** the last block: an answer usually ends with the output its code produced, which is never the one you meant. The rule is "the last *source* block of this answer", decided in three steps: the language tag when there is one (`text`, `output`, `console`, `log`, `stdout` are output); otherwise the line of prose above the fence ("运行示例输出：", "Output:"), because a model that tagged the first output block routinely leaves the second bare; otherwise the content itself, so a bare `npm install -g .` stays copyable while `原始数组: 29 25 3` does not. An answer made only of output falls back to it. Any other block of the same answer is named alongside, so a wrong guess costs one number:

```
❯ /copy
✓ copied [1] python · 52 lines · pbcopy
  this answer also has [2] text · 2 lines — /copy 2
```

`/copy` uses the platform's own command (`pbcopy`, `clip`, `wl-copy`/`xclip`/`xsel`), and falls back to **OSC 52** so the terminal itself does the copying — over SSH the local clipboard is the wrong machine's. `DEEPSEEK_TUI_CLIPBOARD` overrides the lookup.

`/save` is the only place this client writes to the workspace, always at a path you gave it.

When a file you attached comes back rewritten, the turn ends by saying what changed rather than leaving you to spot it in a screen of near-identical code:

```
code block [1] vs src/config.py: +12 −3 · /diff 1 · /save 1 src/config.py
```

Applying it for real is still `/do`, which hands the job to DSH.

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
| `races.jsonl` | Verdicts from `/race` (`0600`); the evidence behind `/effort auto` |
| `dsh/` | DSH state and rotated logs |

Environment: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_DSH_COMMAND`, `DEEPSEEK_TUI_CLIPBOARD`, `DEEPSEEK_TUI_HOME`, `NO_COLOR`.

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
- `/effort auto` reasons only from your own races, so its samples are few; it says when it has no basis, and the question classifier is local keyword matching, not comprehension.
- `/continue` and `/prefill` need the official beta prefix completion; a custom endpoint may not serve it.
- Reading a file is `/attach` only, writing one is `/save` only — both at a path you type, neither initiated by the model.

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
