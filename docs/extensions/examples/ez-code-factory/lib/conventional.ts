// ── Conventional-commit title helper — port of internal/conventional/title.go ──
//
// The PR step's title MUST be a conventional-commit subject (`type(scope):
// description`). `tightenTitle` accepts an already-conventional title verbatim
// and, for a bare title, infers the best `type` prefix from the wording. The
// type-inference heuristics (documentation / feature / fix / product-impact
// language) are ported VERBATIM from title.go so the PR titles match the
// audited original. Pure — no IO.

/** `type(scope)!: description` matcher — a lowercase type, optional
 *  `(scope)`, optional breaking `!`, then `: ` and a non-empty description.
 *  Verbatim from title.go titleRe. */
const TITLE_RE = /^([a-z]+)(\([^)]+\))?(!)?: (.+)$/;

/** The conventional-commit types release automation recognizes. Verbatim validTypes. */
const VALID_TYPES: ReadonlySet<string> = new Set([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
]);

/** The release-type rule appended to the PR-content prompt. Verbatim ReleaseTypeRule. */
export const RELEASE_TYPE_RULE =
  "- If the change has any user-facing product impact, the type must use feat or fix so release automation can pick it up. Use feat for a new user-visible capability and fix for a user-visible correction or behavior improvement. Use docs, refactor, chore, test, build, or ci only when the change has no user-facing product behavior impact.";

/** True when `title` already parses as a conventional-commit subject with a
 *  recognized type. Verbatim IsTitle. */
export function isTitle(title: string): boolean {
  const m = TITLE_RE.exec(title.trim());
  return m !== null && VALID_TYPES.has(m[1]!);
}

/**
 * Return `title` unchanged when it is already a conventional-commit subject;
 * otherwise prefix an inferred `type: `. Verbatim TightenTitle.
 */
export function tightenTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") return "";
  const m = TITLE_RE.exec(trimmed);
  if (m === null || !VALID_TYPES.has(m[1]!)) return `${inferType(trimmed)}: ${trimmed}`;
  return trimmed;
}

/** Infer a conventional-commit type from free-text wording. Verbatim inferType. */
function inferType(text: string): string {
  const lower = text.toLowerCase().trim();
  if (hasDocumentationLanguage(lower)) return "docs";
  if (hasProductImpactLanguage(lower) || isFeatureLanguage(lower) || isFixLanguage(lower)) {
    return inferReleaseType(lower);
  }
  return "chore";
}

/** feat when the wording reads as a new capability, else fix. Verbatim inferReleaseType. */
function inferReleaseType(text: string): string {
  return isFeatureLanguage(text) ? "feat" : "fix";
}

/** True when the text opens with fix/correct/repair-family wording. Verbatim isFixLanguage. */
function isFixLanguage(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const fixPrefixes = [
    "fix ", "fixes ", "fixed ", "resolve ", "resolves ", "resolved ",
    "correct ", "corrects ", "corrected ", "repair ", "repairs ", "repaired ",
  ];
  return fixPrefixes.some((p) => lower.startsWith(p));
}

/** True when the text opens with add/create/introduce-family wording (or
 *  mentions "new"). Verbatim isFeatureLanguage. */
function isFeatureLanguage(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const featurePrefixes = [
    "add ", "adds ", "added ", "introduce ", "introduces ", "introduced ",
    "create ", "creates ", "created ", "implement ", "implements ", "implemented ",
    "support ", "supports ", "supported ", "enable ", "enables ", "enabled ",
    "allow ", "allows ", "allowed ",
  ];
  if (featurePrefixes.some((p) => lower.startsWith(p))) return true;
  return lower.includes(" new ") || lower.startsWith("new ");
}

/** True when the wording signals user-facing product impact. Verbatim hasProductImpactLanguage. */
function hasProductImpactLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  const terms = [
    "user-facing", "user visible", "user-visible", "user experience", " ux", "ux ",
    " ui", "ui ", "cli", "command", "output", "behavior", "workflow",
    "prompt", "flag", "error message",
  ];
  return terms.some((t) => lower.includes(t));
}

/** True when the text mentions docs/readme. Verbatim hasDocumentationLanguage. */
function hasDocumentationLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("readme") || lower.includes("documentation") || lower.includes("docs");
}
