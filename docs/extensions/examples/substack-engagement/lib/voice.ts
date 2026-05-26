// ── voice — draft composition in the creator's voice ───────────
//
// Two layers:
//   1. `composeReplyPrompt(...)` — a PURE function that builds the user
//      prompt for the LLM from the voice-profile + the source text +
//      the engagement framework. Tested directly, no LLM.
//   2. `draftReply(...)` — calls the `Llm` runtime (via an injectable
//      seam) with the voice-profile's system guidance + the composed
//      prompt. Surfaces LLM errors and refuses empty output.
//
// The voice-profile entity is the runtime-editable voice; the agent
// prompt (manifest) is the always-on fallback. When no voice-profile
// exists, `composeReplyPrompt` degrades to the framework alone and the
// caller passes the agent prompt as the system guidance.

// ── Voice profile shape (mirrors the manifest entity schema) ────

export interface VoiceProfile {
  name?: string;
  voiceDescription?: string;
  doRules?: string[];
  dontRules?: string[];
  sampleReplies?: string[];
}

export type DraftFramework = "reply" | "welcome-dm" | "note-comment";

const FRAMEWORK_GUIDANCE: Record<DraftFramework, string> = {
  reply:
    "Draft a reply to this comment. Ask a genuine follow-up question when " +
    "it fits, mirror the commenter's tone, and keep it to 2-3 sentences.",
  "welcome-dm":
    "Draft a short, warm welcome direct message to a brand-new subscriber. " +
    "Make it personal, set one light expectation about what they'll get, " +
    "and invite a reply. Keep it to 2-4 sentences.",
  "note-comment":
    "Draft a thoughtful comment on this Note. Add something of substance " +
    "(a question, a build-on, a specific reaction) — never a generic " +
    "'great post'. Keep it to 1-2 sentences.",
};

/**
 * Build the LLM user prompt for a draft. PURE — no I/O. Includes the
 * voice-profile do/don't rules + sample replies when present, the
 * framework guidance, and the source text the draft responds to.
 *
 * When `voiceProfile` is null/empty, the do/don't/sample sections are
 * omitted and only the framework + source text remain; the caller is
 * expected to pass the agent prompt as the system guidance so the voice
 * still has a floor.
 */
export function composeReplyPrompt(
  voiceProfile: VoiceProfile | null,
  sourceText: string,
  framework: DraftFramework,
): string {
  const lines: string[] = [];
  lines.push(FRAMEWORK_GUIDANCE[framework]);
  lines.push("");

  if (voiceProfile) {
    if (voiceProfile.voiceDescription && voiceProfile.voiceDescription.trim()) {
      lines.push(`Voice: ${voiceProfile.voiceDescription.trim()}`);
    }
    const dos = (voiceProfile.doRules ?? []).filter((r) => r.trim().length > 0);
    if (dos.length > 0) {
      lines.push("Do:");
      for (const r of dos) lines.push(`- ${r}`);
    }
    const donts = (voiceProfile.dontRules ?? []).filter((r) => r.trim().length > 0);
    if (donts.length > 0) {
      lines.push("Don't:");
      for (const r of donts) lines.push(`- ${r}`);
    }
    const samples = (voiceProfile.sampleReplies ?? []).filter(
      (s) => s.trim().length > 0,
    );
    if (samples.length > 0) {
      lines.push("Sample replies that match the voice:");
      for (const s of samples) lines.push(`- ${s}`);
    }
    if (lines[lines.length - 1] !== "") lines.push("");
  }

  lines.push("Respond to this:");
  lines.push(`"""${sourceText}"""`);
  lines.push("");
  lines.push(
    "Output ONLY the draft text — no preamble, no quotes, no labels. " +
      "It will be queued for the human to review before anything is sent.",
  );
  return lines.join("\n");
}

// ── LLM seam ────────────────────────────────────────────────────
//
// Narrow facade — only `content` is read, so tests inject a one-field
// fake without constructing a full LlmCompleteResult. Mirrors substack-
// pilot's ComposeLlm seam.

export interface DraftLlm {
  complete(opts: {
    provider: string;
    model: string;
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface DraftReplyOpts {
  llm: DraftLlm;
  provider: string;
  model: string;
  maxTokens: number;
  /** System guidance: the voice-profile description or the agent prompt. */
  systemPrompt: string;
  voiceProfile: VoiceProfile | null;
  sourceText: string;
  framework: DraftFramework;
}

export type DraftResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Compose a draft via the LLM. Surfaces LLM errors as `{ ok:false }`
 * (so the calling tool emits a clean tool error) and refuses empty
 * output. Never throws for an expected failure.
 */
export async function draftReply(opts: DraftReplyOpts): Promise<DraftResult> {
  const userPrompt = composeReplyPrompt(
    opts.voiceProfile,
    opts.sourceText,
    opts.framework,
  );
  let res: { content: string };
  try {
    res = await opts.llm.complete({
      provider: opts.provider,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: opts.maxTokens,
    });
  } catch (err) {
    return { ok: false, error: `LLM draft failed: ${(err as Error).message}` };
  }
  const body = (res.content ?? "").trim();
  if (body.length === 0) {
    return { ok: false, error: "LLM returned empty draft — refusing to queue." };
  }
  return { ok: true, body };
}
