import { assertFactoryGitPath, FactoryGitObjectError } from "../git-objects";
import type { ReferenceCodeFile, ReferenceCodeSnapshot } from "./snapshot";

/**
 * The rules a generated candidate is written under, shared by the host generator's tool loop and
 * the guest generator's one-call answer (W4H-28). One copy, so the two cannot disagree about which
 * path a model may write or how large a file may be. Guest-safe: no model SDK, no subprocess.
 */

export const REFERENCE_CODE_MAX_WRITE_BYTES = 256 * 1024;

/**
 * The repository's protected policy, as the operator states it when a run starts.
 *
 * It travels in the run's `repositoryConnection`, is sealed into the snapshot by
 * snapshotRepository, and is read back from that snapshot by freeze and the protected checks. The
 * generator sees it but cannot change it: nothing downstream reads it from the generator's output.
 */
export interface ReferenceCodeRepositoryPolicy {
  /** The GitHub repository id a pull request is opened against (W07). */
  readonly repositoryId: number;
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  /** The fixture-specific protected tests, run on their own as their own claim. */
  readonly protectedTestPaths: readonly string[];
}

export class ReferenceCodePolicyError extends Error {
  readonly code = "reference_code_policy_invalid";
  constructor(detail: string) {
    super(`reference_code_policy_invalid: ${detail}`);
    this.name = "ReferenceCodePolicyError";
  }
}

const pathList = (value: unknown, field: string, nonEmpty: boolean): readonly string[] => {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.length > 256 || !value.every(entry => typeof entry === "string" && entry.length > 0 && entry.length <= 1_024)) {
    throw new ReferenceCodePolicyError(`${field} must be ${nonEmpty ? "a non-empty" : "a"} list of repository paths`);
  }
  return Object.freeze([...value]);
};

/** The policy a connection states, or a named refusal. */
export function referenceCodeRepositoryPolicy(value: unknown): ReferenceCodeRepositoryPolicy {
  const policy = value as Partial<Record<keyof ReferenceCodeRepositoryPolicy, unknown>> | null;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new ReferenceCodePolicyError("a connection states its policy as an object");
  if (!Number.isSafeInteger(policy.repositoryId) || (policy.repositoryId as number) < 1) throw new ReferenceCodePolicyError("repositoryId must be a positive integer");
  return Object.freeze({
    repositoryId: policy.repositoryId as number,
    allowedPaths: pathList(policy.allowedPaths, "allowedPaths", true),
    protectedPaths: pathList(policy.protectedPaths, "protectedPaths", false),
    protectedTestPaths: pathList(policy.protectedTestPaths, "protectedTestPaths", false),
  });
}

/** Why a path cannot be written, or `undefined` when the repository can store it. */
export function referenceCodePathRefusal(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0) return "a path is required";
  try { assertFactoryGitPath(path); }
  catch (error) {
    if (error instanceof FactoryGitObjectError) return `'${path}' is not a path this repository can store`;
    throw error;
  }
  return undefined;
}

export type ReferenceCodeWrite = { readonly ok: true; readonly detail: string; readonly bytes: number } | { readonly ok: false; readonly detail: string };

/** Writes one whole file into a working tree, or says why it may not. Creates a missing file as 100644. */
export function referenceCodeWriteFile(files: Map<string, ReferenceCodeFile>, path: unknown, content: unknown): ReferenceCodeWrite {
  const refused = referenceCodePathRefusal(path);
  if (refused !== undefined) return { ok: false, detail: refused };
  if (typeof content !== "string") return { ok: false, detail: "content must be a string" };
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > REFERENCE_CODE_MAX_WRITE_BYTES) return { ok: false, detail: `'${path as string}' would exceed the ${REFERENCE_CODE_MAX_WRITE_BYTES}-byte write limit` };
  const existing = files.get(path as string);
  files.set(path as string, { path: path as string, mode: existing?.mode ?? "100644", content: bytes });
  return { ok: true, detail: existing === undefined ? `created, ${bytes.byteLength} bytes` : `replaced, ${bytes.byteLength} bytes`, bytes: bytes.byteLength };
}

/** The protected rules every generator is told, before its own tool or answer instructions. */
export function referenceCodeRuleLines(input: {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly scripts: ReferenceCodeSnapshot["scripts"];
}): string[] {
  return [
    "Rules:",
    `- You may change files under: ${input.allowedPaths.join(", ")}. Changing anything else will be refused by the protected checks.`,
    `- These files are protected and must stay byte-identical: ${input.protectedPaths.join(", ")}.`,
    "- Do not add dependencies. The lockfile is frozen and the checks install with --frozen-lockfile.",
    "- Do not embed credentials, tokens, or keys of any kind.",
    `- Your work must satisfy: \`${input.scripts.build}\`, \`${input.scripts.typecheck}\`, and \`${input.scripts.test}\`.`,
  ];
}
