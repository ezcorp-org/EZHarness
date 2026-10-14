import { referenceCodeRuleLines, referenceCodeWriteFile, type ReferenceCodeRepositoryPolicy } from "./candidate-rules";
import { referenceCodeChangedPaths, referenceCodeFilesDigest, type ReferenceCodeFile, type ReferenceCodeSnapshot } from "./snapshot";

/**
 * generateCandidate as it runs in a guest: one model call, a strict JSON answer, a complete tree
 * (W4H-28 P1).
 *
 * The host generator (`generate.ts`) runs a tool loop with the model in process. A guest has one
 * reverse frame and one bounded call per attempt, so the model is shown the whole repository and
 * answers with every file it creates or replaces, in full. The answer is parsed here and applied
 * under the same write rules the host tool loop uses (`candidate-rules.ts`). A rejected candidate
 * comes back through the repair loop with its findings as the next attempt's remediation, so a
 * wrong answer costs one more bounded call, never an unbounded conversation.
 */

export const REFERENCE_CODE_GENERATION_SCHEMA_VERSION = "factory.reference-code-generation.v1" as const;
export const REFERENCE_CODE_GUEST_MAX_OUTPUT_TOKENS = 8_192;
const MAX_ANSWER_FILES = 64;
const MAX_SUMMARY = 512;

export class ReferenceCodeAnswerError extends Error {
  readonly code = "reference_code_answer_invalid";
  constructor(detail: string) {
    super(`reference_code_answer_invalid: ${detail}`);
    this.name = "ReferenceCodeAnswerError";
  }
}

/** The instructions the guest generator works under: the shared rules, then the answer format. */
export function referenceCodeGuestSystemPrompt(snapshot: ReferenceCodeSnapshot, policy: ReferenceCodeRepositoryPolicy): string {
  return [
    "You are the EZCorp reference code factory's generator. You edit one small Bun and TypeScript package to satisfy one request.",
    "",
    ...referenceCodeRuleLines({ allowedPaths: policy.allowedPaths, protectedPaths: policy.protectedPaths, scripts: snapshot.scripts }),
    "",
    "Answer with ONE JSON object and nothing else, in this exact shape:",
    '{"files":[{"path":"<repository-relative path>","content":"<the complete new text of that file>"}],"summary":"<one sentence on what changed>"}',
    "List only the files you create or replace, each with its complete text. There is no patch format and no deletion.",
  ].join("\n");
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** The request, the whole repository, and the findings a previous candidate was rejected for. */
export function referenceCodeGuestUserPrompt(snapshot: ReferenceCodeSnapshot, request: string, remediation: string): string {
  const files = snapshot.files.map(file => `=== ${file.path} ===\n${decoder.decode(file.content)}`).join("\n\n");
  const repair = remediation.trim().length === 0 ? "" : `\n\nA previous candidate was rejected. Fix exactly these findings:\n${remediation.trim()}`;
  return `Request:\n${request}\n\nThe repository at base commit ${snapshot.baseSha} contains these files:\n\n${files}${repair}`;
}

/** The one JSON object an answer holds, with a single surrounding code fence tolerated. */
function answerObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let parsed: unknown;
  try { parsed = JSON.parse(fenced ? fenced[1]! : trimmed); }
  catch { throw new ReferenceCodeAnswerError("the answer is not one JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReferenceCodeAnswerError("the answer is not one JSON object");
  return parsed as Record<string, unknown>;
}

export interface ReferenceCodeGuestGeneration {
  readonly files: readonly ReferenceCodeFile[];
  readonly filesDigest: string;
  readonly changedPaths: readonly string[];
  readonly summary: string;
}

/** Applies one answer to the snapshot's tree under the shared write rules, or refuses it by name. */
export function referenceCodeApplyGuestAnswer(snapshot: ReferenceCodeSnapshot, text: string): ReferenceCodeGuestGeneration {
  const answer = answerObject(text);
  if (!Array.isArray(answer.files) || answer.files.length === 0 || answer.files.length > MAX_ANSWER_FILES) {
    throw new ReferenceCodeAnswerError(`files must list 1 to ${MAX_ANSWER_FILES} files`);
  }
  const tree = new Map(snapshot.files.map(file => [file.path, file]));
  for (const entry of answer.files as unknown[]) {
    const file = entry as { path?: unknown; content?: unknown } | null;
    const written = referenceCodeWriteFile(tree, file?.path, file?.content);
    if (!written.ok) throw new ReferenceCodeAnswerError(written.detail);
  }
  const files = [...tree.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const summary = typeof answer.summary === "string" ? answer.summary.slice(0, MAX_SUMMARY) : "";
  return Object.freeze({ files, filesDigest: referenceCodeFilesDigest(files), changedPaths: referenceCodeChangedPaths(snapshot.files, files), summary });
}
