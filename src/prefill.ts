/**
 * Prefill: force the next answer to *start* with something.
 *
 * DeepSeek's beta prefix completion takes a trailing assistant message and
 * finishes it instead of replying after it. That is the difference between
 * asking for "only the code" and getting it: the answer cannot open with a
 * paragraph of preamble if it is already past the opening fence.
 */

/** A prompt line cannot hold a real newline, so `\n` and `\t` are spelled out. */
function unescape(value: string): string {
  return value.replace(/\\([nt\\])/gu, (_match, code: string) => {
    if (code === "n") return "\n";
    if (code === "t") return "\t";
    return "\\";
  });
}

export interface PrefillPlan {
  /** Text the answer is forced to begin with. */
  text: string;
  /** Stop sequences sent with the request, e.g. the fence that ends code. */
  stop?: string[];
  /** Appended to the answer when `stop` cut off a construct the prefill opened. */
  closing?: string;
  /** One-line rendering for `/status` and confirmations. */
  label: string;
}

/** ```` ```python ```` — a fence with nothing after it opens a code block. */
const BARE_FENCE = /^(`{3,})([A-Za-z0-9+#._-]*)$/u;

/**
 * Turns what the user typed into a plan. Returns undefined for empty input.
 *
 * A bare opening fence is completed into "fence + newline" and paired with a
 * closing stop sequence, which is what makes `/prefill ```python` mean "answer
 * with nothing but Python".
 */
export function planPrefill(raw: string): PrefillPlan | undefined {
  const input = unescape(raw.trim());
  if (!input) return undefined;
  const fence = BARE_FENCE.exec(input);
  if (fence?.[1]) {
    const marker = fence[1];
    return {
      text: `${input}\n`,
      stop: [marker],
      closing: `\n${marker}`,
      label: `${input} ⏎`,
    };
  }
  return { text: input, label: input.replace(/\n/gu, "⏎") };
}

/** How the finished answer is stored: prefill + what the model added. */
export function applyPrefill(plan: PrefillPlan, completion: string): string {
  const body = `${plan.text}${completion}`;
  if (!plan.closing) return body;
  // The stop sequence is not echoed back, so the fence it ended has to be
  // restored — an unterminated fence would swallow the rest of the transcript.
  return `${body.replace(/\s+$/u, "")}${plan.closing}`;
}
