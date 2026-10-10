/**
 * The one git branch-name grammar this repository enforces.
 *
 * Two callers interpolate a name into `refs/heads/<name>` and then into an argv: the v4
 * project pull-request path (`project-open-pr.ts`) and the factory release branch encoder
 * (`src/factory/release-git-refs.ts`). They shared no check before, so the factory's rules
 * lived only in a freeze document and the extension path relied on the shape of its run id.
 * One predicate, used by both, is what makes "the branch is a valid ref" an executable fact.
 *
 * The rules are `git check-ref-format --branch`, restricted to the subset a branch may use:
 * no ASCII control character, space, `~`, `^`, `:`, `?`, `*`, `[`, or backslash; no `..`;
 * no `@{`; no component that starts with `.` or ends with `.lock`; no leading, trailing, or
 * repeated `/`; not exactly `@`; no trailing `.`.
 *
 * Two rules deserve a note. A name may not start with `-`: `git check-ref-format --branch` refuses
 * one for exactly the reason this does, because `check-ref-format` takes no `--` terminator and
 * every caller here passes the name into an argv where a leading dash reads as an option. (Plain
 * `check-ref-format refs/heads/-x` accepts it; the branch-shorthand mode does not.) And the length
 * is capped at 255, which git does not cap at all; a loose ref is a filename, and every name these
 * callers build sits far below the cap.
 */

/** Longest branch name any caller here may build, before `refs/heads/`. */
export const MAX_GIT_BRANCH_LENGTH = 255;

const FORBIDDEN = /[\0-\x20\x7f~^:?*[\\]/;

export class GitRefFormatError extends Error {
  constructor(readonly branch: string) {
    super("The branch name is not a valid git ref.");
    this.name = "GitRefFormatError";
  }
}

/**
 * Exactly `git check-ref-format --branch <value>` for the names this repository builds.
 *
 * Returns false rather than throwing, so a caller can choose its own error vocabulary.
 */
export function isValidGitBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_GIT_BRANCH_LENGTH) return false;
  if (FORBIDDEN.test(value) || value.includes("..") || value.includes("@{") || value === "@") return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.endsWith(".") || value.startsWith("-")) return false;
  return value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The throwing form, for a caller that is about to push the name. */
export function assertGitBranchName(value: string): string {
  if (!isValidGitBranchName(value)) throw new GitRefFormatError(String(value));
  return value;
}

/** `refs/heads/<branch>`, after the branch itself is proved valid. */
export function gitHeadRef(branch: string): string {
  return `refs/heads/${assertGitBranchName(branch)}`;
}
