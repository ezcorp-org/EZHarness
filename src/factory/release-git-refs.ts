import { assertGitBranchName, gitHeadRef, isValidGitBranchName } from "../extensions/project-git-refs";
import { assertFactoryIdentity } from "./records";

/**
 * Git ref encoding for factory operation identities (interface freeze section 11).
 *
 * Every factory operation id carries a colon — `factory-release:<64 hex>`, and the same shape
 * on `factory-reservation:`, `factory-admission:`, and `protected-release:`. A git ref cannot
 * contain a colon, so a branch built from an id needs a reversible representation. Reversible is
 * the requirement, not merely unique: reconciliation finds the branch for an operation, and the
 * operation for a branch, without a lookup table that could itself be lost or forged.
 *
 * The transformation is `encodeURIComponent` plus a post-escape of the seven characters it
 * leaves behind that git forbids or that make a ref ambiguous (`.` `!` `~` `*` `'` `(` `)`).
 * What survives is `A-Z a-z 0-9 - _ %`, which `git check-ref-format` accepts, and
 * `decodeURIComponent` is its exact inverse because every post-escape is a standard `%XX`.
 */

/** Broker-only namespace. Distinct from the `ez-code/` prefix the v4 project path uses. */
export const FACTORY_BRANCH_NAMESPACE = "ezcorp-factory" as const;
export const FACTORY_BRANCH_SUFFIX_MAX_LENGTH = 200;
export const FACTORY_GIT_BRANCH_SCHEMA_VERSION = "factory.git-branch.v1" as const;

/** Every ref this module mints or accepts starts here. */
export const FACTORY_BRANCH_REF_PREFIX = `refs/heads/${FACTORY_BRANCH_NAMESPACE}/` as const;

/** The release destination providers whose objects are git refs. */
export const FACTORY_GIT_RELEASE_PROVIDER = "github" as const;

export interface FactoryGitBranchBinding {
  readonly schemaVersion: typeof FACTORY_GIT_BRANCH_SCHEMA_VERSION;
  /** The original id, colon intact, exactly as stored. */
  readonly operationId: string;
  /** The reversible suffix. */
  readonly suffix: string;
  /** `ezcorp-factory/<suffix>`. */
  readonly branch: string;
  /** `refs/heads/ezcorp-factory/<suffix>`. */
  readonly ref: string;
}

export class FactoryGitRefError extends Error {
  constructor(readonly code: "factory_release_ref_invalid" | "factory_release_ref_too_long" | "factory_release_ref_foreign") {
    super(code);
    this.name = "FactoryGitRefError";
  }
}

/** `encodeURIComponent` leaves these; git forbids them or they make a ref ambiguous. */
const POST_ESCAPE: Readonly<Record<string, string>> = Object.freeze({
  ".": "%2E", "!": "%21", "~": "%7E", "*": "%2A", "'": "%27", "(": "%28", ")": "%29",
});

/** The exact alphabet an encoded suffix may use, and nothing else. */
const SUFFIX_ALPHABET = /^[A-Za-z0-9_%-]+$/;

function invalid(): never { throw new FactoryGitRefError("factory_release_ref_invalid"); }

/** True for a destination whose object identity is a git ref rather than a stored object. */
export function isFactoryGitReleaseProvider(provider: string): boolean {
  return provider === FACTORY_GIT_RELEASE_PROVIDER;
}

/**
 * The reversible branch suffix for one operation id.
 *
 * Throws `factory_identity_invalid` for an id outside the shared identifier rule (1 to 512
 * characters, NUL-free) and `factory_release_ref_too_long` for an id whose encoded form would
 * exceed the branch budget. The length cap applies to git destinations only; nothing else in
 * the platform shortens an operation id.
 */
export function encodeFactoryOperationRefSuffix(operationId: string): string {
  assertFactoryIdentity(operationId);
  const suffix = encodeURIComponent(operationId).replace(/[.!~*'()]/g, character => POST_ESCAPE[character]!);
  if (suffix.length > FACTORY_BRANCH_SUFFIX_MAX_LENGTH) throw new FactoryGitRefError("factory_release_ref_too_long");
  return suffix;
}

/**
 * The exact inverse of `encodeFactoryOperationRefSuffix`.
 *
 * A suffix is accepted only in its canonical form: re-encoding the decoded id must reproduce the
 * same bytes. That rejects lowercase escapes, gratuitous escapes of unreserved characters, and
 * any id the identifier rule refuses, so two different suffixes can never name one operation.
 */
export function decodeFactoryOperationRefSuffix(suffix: string): string {
  if (typeof suffix !== "string" || suffix.length < 1 || suffix.length > FACTORY_BRANCH_SUFFIX_MAX_LENGTH || !SUFFIX_ALPHABET.test(suffix)) invalid();
  let decoded: string;
  let canonical: string;
  try {
    decoded = decodeURIComponent(suffix);
    canonical = encodeFactoryOperationRefSuffix(decoded);
  } catch { invalid(); }
  if (canonical !== suffix) invalid();
  return decoded;
}

/** The branch, the ref, and the id they reverse to, as one frozen record. */
export function factoryGitBranchBinding(operationId: string): FactoryGitBranchBinding {
  const suffix = encodeFactoryOperationRefSuffix(operationId);
  const branch = assertGitBranchName(`${FACTORY_BRANCH_NAMESPACE}/${suffix}`);
  return Object.freeze({
    schemaVersion: FACTORY_GIT_BRANCH_SCHEMA_VERSION,
    operationId,
    suffix,
    branch,
    ref: gitHeadRef(branch),
  });
}

/**
 * The operation id a ref names, with no lookup table.
 *
 * This is what lets reconciliation read one exact ref after a lost branch-create response and
 * know which operation it belongs to. A ref outside the broker-only namespace is
 * `factory_release_ref_foreign`, never silently reinterpreted.
 */
export function factoryOperationIdFromRef(ref: string): string {
  if (typeof ref !== "string" || !ref.startsWith(FACTORY_BRANCH_REF_PREFIX)) throw new FactoryGitRefError("factory_release_ref_foreign");
  return decodeFactoryOperationRefSuffix(ref.slice(FACTORY_BRANCH_REF_PREFIX.length));
}

/**
 * Re-derives a binding and proves a stored or received one equals it.
 *
 * Used on every read of a persisted `destination_ref`/`destination_branch` pair and on every
 * provider receipt that carries a ref, so a tampered row or a receipt naming another branch is
 * refused rather than published against.
 */
export function assertFactoryGitBranchBinding(binding: Pick<FactoryGitBranchBinding, "branch" | "ref">, operationId: string): FactoryGitBranchBinding {
  const expected = factoryGitBranchBinding(operationId);
  if (!binding || typeof binding !== "object" || binding.branch !== expected.branch || binding.ref !== expected.ref) throw new FactoryGitRefError("factory_release_ref_foreign");
  return expected;
}

/** True when a branch name is inside the broker-only namespace and is a valid ref. */
export function isFactoryBrokerBranch(branch: unknown): branch is string {
  return isValidGitBranchName(branch) && branch.startsWith(`${FACTORY_BRANCH_NAMESPACE}/`);
}
