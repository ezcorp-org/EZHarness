// ── pipeline — deterministic role-prompted stages ──────────────
//
// Three tools the LLM sequences per `skills/substack-pipeline/SKILL.md`.
// The human turn is the platform's wired `ask_user_question` (the LLM
// calls it; substack-pipeline never cross-ext-invokes a
// `requiresUserInput` tool — see README "Host limitation"). State rides
// in conversation-scoped storage (`lib/scratch.ts`), not through the LLM.
//
//   draft_substack_post   : SUMMARIZER (substack-pilot) + WRITER → scratch
//   revise_substack_post  : WRITER(prevDraft+feedback) → scratch (soft cap)
//   finalize_substack_post: ILLUSTRATOR + IMAGE (openai-image-gen-2)
//
// All I/O goes through swappable seams (`_setLlmForTests`,
// invoke-helpers' `_setInvokeForTests`, scratch's `_setStoreForTests`)
// so the whole flow is unit-testable with no network / LLM / subprocess.

import { Llm, toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";
import {
  WRITER_PROMPT,
  ILLUSTRATOR_PROMPT,
  MAX_REVISE_ROUNDS,
  buildWriterUserContent,
  extractTitle,
} from "./prompts";
import { summarizeUrl, generateCoverImage } from "./invoke-helpers";
import {
  readScratch,
  writeScratch,
  clearScratch,
  type Scratch,
} from "./scratch";

// ── LLM seam (mirrors substack-pilot/lib/substack.ts) ───────────

interface ComposeLlm {
  complete(opts: {
    provider: string;
    model: string;
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

let _llm: ComposeLlm = new Llm();
let _provider = "anthropic";
let _model = "claude-3-5-haiku-20241022";

/** Test-only: inject a fake LLM. Pass null to restore the real client. */
export function _setLlmForTests(llm: ComposeLlm | null): void {
  _llm = llm ?? new Llm();
}
/** Test-only: override the default provider/model. */
export function _setLlmModelForTests(provider: string, model: string): void {
  _provider = provider;
  _model = model;
}
/** Test-only: restore production LLM bindings. */
export function _resetLlmForTests(): void {
  _llm = new Llm();
  _provider = "anthropic";
  _model = "claude-3-5-haiku-20241022";
}

async function runWriter(
  input: Parameters<typeof buildWriterUserContent>[0],
): Promise<string> {
  const res = await _llm.complete({
    provider: _provider,
    model: _model,
    systemPrompt: WRITER_PROMPT,
    messages: [{ role: "user", content: buildWriterUserContent(input) }],
    maxTokens: 4096,
  });
  return res.content.trim();
}

// The LLM-facing next-step hints keep the SKILL contract self-correcting
// even if the skill text drifts out of the model's attention.
const AFTER_DRAFT_HINT =
  "\n\n---\n_Next: show this draft to the user, then call " +
  "`ask_user_question` with options [\"Approve\",\"Request changes\"]. " +
  "On Approve → call `finalize_substack_post`. On changes → ask a " +
  "free-text follow-up, then call `revise_substack_post({feedback})`._";

const AFTER_REVISE_HINT =
  "\n\n---\n_Next: show the revised draft, then `ask_user_question` " +
  "again (Approve → `finalize_substack_post`; more changes → " +
  "`revise_substack_post`)._";

// ── Tool: draft_substack_post ───────────────────────────────────

export async function draftPost(
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const url = args.url;
  const styleNote =
    typeof args.styleNote === "string" && args.styleNote.trim().length > 0
      ? args.styleNote.trim()
      : undefined;

  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return toolError("draft_substack_post requires an http(s) 'url' string");
  }

  const sum = await summarizeUrl(url);
  if (sum.error || !sum.summary) {
    return toolError(`Could not summarize ${url}: ${sum.error ?? "no summary"}`);
  }
  const sourceTitle = sum.title || url;

  let draft: string;
  try {
    draft = await runWriter({
      sourceUrl: url,
      sourceTitle,
      summary: sum.summary,
      ...(styleNote ? { styleNote } : {}),
    });
  } catch (err) {
    return toolError(`Writer stage failed: ${(err as Error).message}`);
  }
  if (draft.length === 0) {
    return toolError("Writer produced an empty draft — refusing to continue");
  }

  const scratch: Scratch = {
    url,
    ...(styleNote ? { styleNote } : {}),
    sourceTitle,
    summary: sum.summary,
    draft,
    rounds: 0,
  };
  try {
    await writeScratch(scratch);
  } catch (err) {
    return toolError(`Failed to persist pipeline state: ${(err as Error).message}`);
  }

  const title = extractTitle(draft);
  return toolResult(`# Draft — "${title}"\n\n${draft}${AFTER_DRAFT_HINT}`);
}

// ── Tool: revise_substack_post ──────────────────────────────────

export async function revisePost(
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const feedback =
    typeof args.feedback === "string" ? args.feedback.trim() : "";
  if (feedback.length === 0) {
    return toolError("revise_substack_post requires non-empty 'feedback'");
  }

  let scratch: Scratch | null;
  try {
    scratch = await readScratch();
  } catch (err) {
    return toolError(`Failed to read pipeline state: ${(err as Error).message}`);
  }
  if (!scratch) {
    return toolError(
      "No draft in progress — call draft_substack_post first.",
      "NO_SCRATCH",
    );
  }

  let draft: string;
  try {
    draft = await runWriter({
      sourceUrl: scratch.url,
      sourceTitle: scratch.sourceTitle,
      summary: scratch.summary,
      ...(scratch.styleNote ? { styleNote: scratch.styleNote } : {}),
      prevDraft: scratch.draft,
      feedback,
    });
  } catch (err) {
    return toolError(`Revision failed: ${(err as Error).message}`);
  }
  if (draft.length === 0) {
    return toolError("Writer returned an empty revision — kept the prior draft");
  }

  const rounds = scratch.rounds + 1;
  try {
    await writeScratch({ ...scratch, draft, rounds });
  } catch (err) {
    return toolError(`Failed to persist revision: ${(err as Error).message}`);
  }

  const title = extractTitle(draft);
  const capNote =
    rounds >= MAX_REVISE_ROUNDS
      ? `\n\n_(${rounds}/${MAX_REVISE_ROUNDS} revise rounds used — if the ` +
        "user still wants changes, make one more pass then call " +
        "`finalize_substack_post` regardless.)_"
      : "";
  return toolResult(
    `# Revised draft — "${title}"\n\n${draft}${capNote}${AFTER_REVISE_HINT}`,
  );
}

// ── Tool: finalize_substack_post ────────────────────────────────

export async function finalizePost(): Promise<ToolCallResult> {
  let scratch: Scratch | null;
  try {
    scratch = await readScratch();
  } catch (err) {
    return toolError(`Failed to read pipeline state: ${(err as Error).message}`);
  }
  if (!scratch) {
    return toolError(
      "No draft in progress — call draft_substack_post first.",
      "NO_SCRATCH",
    );
  }

  const notes: string[] = [];

  let imagePrompt = "";
  try {
    const res = await _llm.complete({
      provider: _provider,
      model: _model,
      systemPrompt: ILLUSTRATOR_PROMPT,
      messages: [{ role: "user", content: scratch.draft }],
      maxTokens: 300,
    });
    imagePrompt = res.content.trim();
  } catch (err) {
    notes.push(`Illustrator stage failed (${(err as Error).message}); no cover image.`);
  }

  let imageMarkdown = "";
  if (imagePrompt.length > 0) {
    const img = await generateCoverImage(imagePrompt);
    if (img.error || !img.markdown) {
      notes.push(`Cover image failed (${img.error ?? "no image"}); article only.`);
    } else {
      imageMarkdown = img.markdown.trim();
    }
  }

  // Best-effort cleanup — a failed delete must not sink a finished post.
  try {
    await clearScratch();
  } catch {
    /* scratch is conversation-scoped + bounded; stale key is harmless */
  }

  const parts: string[] = [];
  if (imageMarkdown) parts.push(imageMarkdown);
  parts.push(scratch.draft);
  if (notes.length > 0) {
    parts.push(`---\n\n_Pipeline notes:_\n${notes.map((n) => `- ${n}`).join("\n")}`);
  }
  return toolResult(parts.join("\n\n"));
}
