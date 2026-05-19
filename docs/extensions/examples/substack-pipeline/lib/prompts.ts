// ── prompts — role system prompts + message builders ────────────
//
// Each pipeline stage is a distinct role-prompted LLM call. The system
// prompts here ARE the "agents" the user asked for — WRITER turns a
// summary into a Substack post, ILLUSTRATOR turns the finished post into
// a single image-generation prompt. Kept pure (no I/O) so the pipeline
// orchestration and these prompts are independently testable.

/** Hard cap on user revise rounds before the pipeline ships the latest
 *  draft with a note. Bounds the ask-user loop so a user who never
 *  clicks "Approve" can't spin the writer forever. */
export const MAX_REVISE_ROUNDS = 5;

export const WRITER_PROMPT =
  "You are a senior Substack writer. You turn a short factual summary of a " +
  "source article into an original, publish-ready Substack post — NOT a " +
  "regurgitation of the source. Write in clean Markdown: a compelling H1 " +
  "title line, then the body with short paragraphs, the occasional subhead, " +
  "and a one-line takeaway near the end. Conversational but substantive; no " +
  "filler, no 'in this post we will', no SEO padding. Aim for 500–900 words. " +
  "Attribute the source inline once (link the source URL). Output ONLY the " +
  "Markdown post — no preamble, no meta commentary, no code fences.";

export const ILLUSTRATOR_PROMPT =
  "You write image-generation prompts for editorial cover art. Given a " +
  "finished article, produce ONE vivid, concrete prompt (≤60 words) for a " +
  "wide cover image that captures the article's core idea as a metaphor or " +
  "scene. Specify subject, composition, style, and mood. No text/letters in " +
  "the image. Output ONLY the prompt — no quotes, no preamble.";

export interface WriterInput {
  sourceUrl: string;
  sourceTitle: string;
  summary: string;
  styleNote?: string;
  /** Present on revise rounds — the draft the user gave feedback on. */
  prevDraft?: string;
  /** Present on revise rounds — the user's verbatim change request. */
  feedback?: string;
}

/** Build the WRITER user message. Initial round gets the summary; revise
 *  rounds get the prior draft + the user's feedback so the model edits
 *  in place rather than starting over. */
export function buildWriterUserContent(input: WriterInput): string {
  const lines: string[] = [];
  if (input.prevDraft && input.feedback) {
    lines.push(
      "Revise the Substack post below per the reader's feedback. Keep what " +
        "works; change what they asked for. Return the FULL revised post in " +
        "Markdown (same output rules as before).",
    );
    if (input.styleNote) lines.push("", `Style steer: ${input.styleNote}`);
    lines.push("", "── Reader feedback ──", input.feedback);
    lines.push("", "── Current draft ──", input.prevDraft);
    return lines.join("\n");
  }

  lines.push(`Source URL: ${input.sourceUrl}`);
  lines.push(`Source title: ${input.sourceTitle}`);
  if (input.styleNote) lines.push(`Style steer: ${input.styleNote}`);
  lines.push("", "── Source summary ──", input.summary);
  lines.push(
    "",
    "Write the Substack post from this summary following the system rules.",
  );
  return lines.join("\n");
}

/** First Markdown H1 (`# Title`) in the body, or a fallback. Used for the
 *  approve/revise prompt header so the user sees what they're judging. */
export function extractTitle(body: string, fallback = "Untitled draft"): string {
  for (const raw of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(raw.trim());
    if (m && m[1]) return m[1].trim();
  }
  return fallback;
}
