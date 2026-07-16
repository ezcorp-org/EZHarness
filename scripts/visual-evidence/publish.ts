#!/usr/bin/env bun
/**
 * Visual-evidence PUBLISHER — runs in WF2
 * (`visual-evidence-publish.yml`), the PRIVILEGED tier
 * (`contents: write`, `pull-requests: write`).
 *
 * SECURITY MODEL (read before editing): WF2 is an `on: workflow_run` workflow,
 * so it always executes the workflow file from the DEFAULT branch — a PR cannot
 * alter it. It NEVER `actions/checkout`s the PR code. Its ONLY inputs are the
 * artifact bytes downloaded from WF1 (`manifest.json` + extracted PNGs), and
 * those bytes are UNTRUSTED — a malicious PR controls the screenshot contents,
 * the attachment labels, and (in the limit) the manifest. Therefore EVERY value
 * is re-validated here before it touches a filename, a `git` ref, a URL, or
 * markdown:
 *   - `validatePrNumber`  — PR# must be `^[0-9]+$` (no branch/ref injection).
 *   - `isSafeRelPath`     — no absolute paths, no `..` segment (no traversal).
 *   - `isPng`             — magic-byte check (no smuggling non-image bytes into
 *                           a public branch / no content-type confusion).
 *   - `sanitizeLabel`     — strip to a safe charset; labels appear in the PR
 *                           comment as PLAIN TEXT only, never inside markdown
 *                           link syntax → no comment-injection / phishing.
 * The gallery URLs are immutable (`raw.githubusercontent.com/<repo>/<commit
 * sha>/...`), so a later force-push to the evidence branch can't swap a
 * rendered image.
 *
 * This module is PURE helpers + a thin `main()`. No browser, no
 * `playwright merge-reports` — it only reads already-decoded PNG files that the
 * trusted builder (`build-manifest.ts`, WF1) wrote, and re-checks them.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const COMMENT_MARKER = "<!-- visual-evidence -->";

/**
 * Max screenshots rendered inline in the sticky comment. Anything beyond this
 * (after the deterministic sort) is collapsed into a single `<details>` block
 * so a large-capture PR doesn't produce a wall of images. Presentation only —
 * every staged shot is still linked, just folded.
 */
export const MAX_INLINE_SHOTS = 12;

/**
 * Body used when WF1 skipped capture (non-visual diff). Posted UPDATE-ONLY:
 * the workflow PATCHes an existing sticky comment (so a gallery from an
 * earlier visual push doesn't outlive the change it depicted) but never
 * creates a new comment — a PR that was never visual stays comment-free.
 */
export function buildSkippedMarkdown(): string {
  return [
    COMMENT_MARKER,
    "## Visual evidence",
    "",
    "No user-visible changes in the current diff — screenshots from earlier pushes " +
      "(if any) are outdated and have been retired.",
  ].join("\n");
}

/**
 * Reduce an untrusted label to a markdown-/shell-safe charset: letters,
 * digits, space, and `._-`. Everything else — crucially `[]()<>` backticks,
 * newlines, `!`, `|`, and `/` — is replaced by a space, so the value can never
 * break out of plain-text context in a PR comment (no `](http://evil)`
 * breakout, no nested image, no HTML). Collapses whitespace; empty → "evidence".
 */
export function sanitizeLabel(s: string): string {
  const cleaned = String(s ?? "")
    .replace(/[^A-Za-z0-9._\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "evidence";
}

/**
 * Reduce an untrusted value to a SINGLE safe path segment: sanitize to the
 * markdown-safe charset, hyphenate spaces, then reject the three segment values
 * that would still be path-hostile after `join` collapses them — "" / "." /
 * ".." — mapping them to "evidence". Guarantees the result is a non-empty,
 * separator-free, non-dotted segment, so it can never escape the staging dir or
 * a URL path component even before `isSafeRelPath` runs. Defense-in-depth on top
 * of `sanitizeLabel` (which already strips `/`).
 */
export function safeSegment(s: string): string {
  const seg = sanitizeLabel(s).replace(/ /g, "-");
  return seg === "" || seg === "." || seg === ".." ? "evidence" : seg;
}

/**
 * Parse + validate a PR number. Accepts a string or number that is a run of
 * ASCII digits (optionally surrounded by whitespace); throws on anything else.
 * Used to gate the `evidence/pr-<n>` branch name and the gallery URL — both
 * must never contain attacker-chosen ref/path characters.
 */
export function validatePrNumber(s: unknown): number {
  const str = typeof s === "number" ? String(s) : String(s ?? "").trim();
  if (!/^[0-9]+$/.test(str)) {
    throw new Error(`invalid PR number: ${JSON.stringify(s)}`);
  }
  return Number(str);
}

/**
 * True iff `p` is a safe RELATIVE path: not absolute, not empty, and with no
 * `..` segment (before OR after normalization), so it can never escape the
 * staging dir. Backslashes are treated as separators too (defensive on a
 * Windows-authored payload).
 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (isAbsolute(p)) return false;
  const unified = p.replace(/\\/g, "/");
  if (unified.startsWith("/")) return false;
  const segments = unified.split("/");
  if (segments.some((seg) => seg === "..")) return false;
  // Normalize and re-check (catches `a/../../b` collapsing past the root).
  const norm = normalize(unified).replace(/\\/g, "/");
  if (norm.startsWith("..") || norm.startsWith("/") || isAbsolute(norm)) return false;
  return true;
}

/** PNG magic bytes: 89 50 4E 47 — first four bytes of every PNG. */
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

export interface GalleryShot {
  spec: string;
  label: string;
  file: string;
  /**
   * The shot's ORIGINAL manifest spec path (root- or repo-relative, e.g.
   * `e2e/x.spec.ts` / `web/e2e/x.spec.ts`) BEFORE `safeSegment` collapsed its
   * `/` separators to `-`. Optional — only `main()` sets it, purely so the
   * diff-scoped gallery partition can path-suffix-match it against the PR's
   * changed spec files. Rendering never uses it (URLs derive from `spec`);
   * when absent, the partition falls back to `spec`.
   */
  rawSpec?: string;
}

export interface GalleryArgs {
  repo: string;
  branch: string;
  commitSha: string;
  pr: number;
  runId: number;
  shots: GalleryShot[];
  /**
   * OPTIONAL PR-diff spec paths (`web/e2e/**​/*.spec.ts`) parsed from
   * EVIDENCE_CHANGED_FILES. When present AND ≥1 staged shot's spec matches one,
   * the gallery is PARTITIONED: matching shots render inline first, everything
   * else folds into the `<details>` block. Absent / empty / no-match → the P1
   * layout (all shots inline-sorted-capped) byte-for-byte. Presentation only —
   * never a trust decision (see `isChangedShotSpec`).
   */
  changedSpecs?: readonly string[];
}

/**
 * Total order on shots by (spec, label). Plain code-unit `<` comparison — NOT
 * `localeCompare`, whose default-locale ordering could differ between the CI
 * runner and a dev box and make the rendered gallery non-reproducible.
 */
function compareShots(a: GalleryShot, b: GalleryShot): number {
  if (a.spec !== b.spec) return a.spec < b.spec ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return 0;
}

/** Render one shot to its heading + immutable-URL image + trailing blank line. */
function renderShot(shot: GalleryShot, repo: string, commitSha: string, pr: number, runId: number): string[] {
  // URL segments use the hyphenated, sanitized forms so the path is stable
  // and contains no markdown/URL-hostile characters; the comment shows the
  // human label as plain text (never inside the link).
  const specSeg = sanitizeLabel(shot.spec).replace(/ /g, "-");
  const labelSeg = sanitizeLabel(shot.label).replace(/ /g, "-");
  const url =
    `https://raw.githubusercontent.com/${repo}/${commitSha}` +
    `/pr-${pr}/${runId}/${specSeg}/${labelSeg}.png`;
  return [`**${sanitizeLabel(shot.label)}** — \`${specSeg}\``, `![evidence](${url})`, ""];
}

// ── diff-scoped gallery partition (presentation only) ────────────────────────

/**
 * Split a spec / changed-file path into comparable segments: unify `\`→`/`,
 * split on `/`, trim each, drop empties. Lets a shot's spec path-suffix-match
 * the PR's changed spec files across Playwright's two shapes — `e2e/x.spec.ts`
 * (rootDir-relative) vs `web/e2e/x.spec.ts` (repo-relative).
 */
function specPathSegments(p: string): string[] {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * True iff the shorter segment list is a tail-slice of the longer, aligned on
 * `/` boundaries — so `e2e/x.spec.ts` matches `web/e2e/x.spec.ts` but NOT
 * `web/e2e/xx.spec.ts`. Symmetric in its arguments.
 */
function isSpecSuffixMatch(a: readonly string[], b: readonly string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const offset = long.length - short.length;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[offset + i]) return false;
  }
  return true;
}

/**
 * True iff `shotSpec` (a manifest spec, root- OR repo-relative) names the SAME
 * spec file as any of `changedSpecPaths` (repo-relative `web/e2e/**​/*.spec.ts`
 * from the PR diff), via segment-aligned suffix match in either direction.
 *
 * SECURITY: `shotSpec` is attacker-controlled artifact text. It is used ONLY to
 * float a shot into the inline gallery section — never a trust / authorization
 * decision. A hostile spec can at worst self-promote to inline; it is still
 * rendered through `sanitizeLabel` / `safeSegment`, so it stays inert plain text.
 */
export function isChangedShotSpec(shotSpec: string, changedSpecPaths: readonly string[]): boolean {
  const shotSegs = specPathSegments(shotSpec);
  if (shotSegs.length === 0) return false;
  for (const changed of changedSpecPaths) {
    const changedSegs = specPathSegments(changed);
    if (changedSegs.length === 0) continue;
    if (isSpecSuffixMatch(shotSegs, changedSegs)) return true;
  }
  return false;
}

/**
 * Extract the changed e2e SPEC paths from raw EVIDENCE_CHANGED_FILES content
 * (one `gh api .../files --jq '.[].filename'` line each, repo-relative). Keeps
 * only `web/e2e/**​/*.spec.ts` lines — a shot floats inline iff its own spec
 * file is in this set. Absent / blank → `[]`.
 */
export function parseChangedSpecPaths(content: string): string[] {
  const out: string[] = [];
  for (const raw of String(content ?? "").split("\n")) {
    const line = raw.replace(/\\/g, "/").trim();
    if (line.startsWith("web/e2e/") && line.endsWith(".spec.ts")) out.push(line);
  }
  return out;
}

/**
 * Build the sticky-comment body. Always begins with `COMMENT_MARKER` (so WF2
 * can find + upsert it) and a heading. Shots are rendered in a DETERMINISTIC
 * (spec, label) order — the staging pass hands them over in nondeterministic
 * worker-completion order, so we sort here to keep the comment reproducible.
 *
 * DIFF-SCOPED PARTITION (P3): when `changedSpecs` is supplied AND ≥1 staged
 * shot's spec matches a changed spec file, the gallery is partitioned — the
 * matching ("changed") shots render inline first (still (spec,label)-sorted,
 * `MAX_INLINE_SHOTS` cap applied to that section), and ALL remaining shots
 * (changed-overflow first, then the untouched rest) fold into the single
 * `<details>` block titled `N more screenshot(s) from the full suite`. With no
 * changed-file info — or when nothing matched — the layout is the P1 default:
 * the first `MAX_INLINE_SHOTS` inline, the remainder folded under `N more
 * screenshot(s)`. Either way the partition only REORDERS; every shot stays
 * linked, and a blank line after `<summary>` lets GitHub parse the enclosed
 * image markdown.
 *
 * Each shot emits a fixed-alt-text image pointing at the IMMUTABLE
 * `raw.githubusercontent.com/<repo>/<commit sha>/pr-<pr>/<runId>/<spec>/<label>.png`
 * URL, with the SANITIZED label as adjacent plain text — never inside the link
 * syntax. When `shots` is empty, returns the ⚠️ "no screenshot captured" body.
 */
export function buildGalleryMarkdown(args: GalleryArgs): string {
  const { repo, commitSha, pr, runId, shots, changedSpecs } = args;
  if (shots.length === 0) {
    return [
      COMMENT_MARKER,
      "## Visual evidence",
      "",
      "⚠️ No screenshot captured for this PR — re-run CI or add an `@evidence` spec " +
        "that calls `captureEvidence(page, testInfo, label)`.",
    ].join("\n");
  }
  const sortedAll = [...shots].sort(compareShots);

  // Partition into "changed" (this PR touched the shot's own spec file) vs the
  // rest, but only when we actually have changed-file info. The loop preserves
  // the (spec,label)-sorted order within each bucket.
  const changedSpecPaths = changedSpecs ?? [];
  const changed: GalleryShot[] = [];
  const rest: GalleryShot[] = [];
  if (changedSpecPaths.length > 0) {
    for (const shot of sortedAll) {
      (isChangedShotSpec(shot.rawSpec ?? shot.spec, changedSpecPaths) ? changed : rest).push(shot);
    }
  }
  // Fail-soft: no changed-file info OR nothing matched → the exact P1 layout
  // (byte-identical), which also avoids an empty-inline / all-folded gallery if
  // the diff fetch failed and yielded no usable spec paths.
  const partitioned = changed.length > 0;

  let inline: GalleryShot[];
  let overflow: GalleryShot[];
  let overflowSummary: string;
  if (partitioned) {
    inline = changed.slice(0, MAX_INLINE_SHOTS);
    overflow = [...changed.slice(MAX_INLINE_SHOTS), ...rest];
    overflowSummary = `${overflow.length} more screenshot(s) from the full suite`;
  } else {
    inline = sortedAll.slice(0, MAX_INLINE_SHOTS);
    overflow = sortedAll.slice(MAX_INLINE_SHOTS);
    overflowSummary = `${overflow.length} more screenshot(s)`;
  }

  const lines: string[] = [COMMENT_MARKER, "## Visual evidence", ""];
  for (const shot of inline) {
    lines.push(...renderShot(shot, repo, commitSha, pr, runId));
  }
  if (overflow.length > 0) {
    lines.push(`<details><summary>${overflowSummary}</summary>`);
    lines.push("");
    for (const shot of overflow) {
      lines.push(...renderShot(shot, repo, commitSha, pr, runId));
    }
    lines.push("</details>");
  }
  return lines.join("\n").trimEnd();
}

// ── main(): validate the downloaded artifact, stage the tree, emit outputs ───

interface ManifestShape {
  pr?: unknown;
  headSha?: unknown;
  runId?: unknown;
  shots?: unknown;
  skipped?: unknown;
}

/** Append a `key=value` (multiline-safe) record to `$GITHUB_OUTPUT`. */
async function emitOutput(key: string, value: string): Promise<void> {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const delim = `__EVIDENCE_${key}_${Date.now()}__`;
  await Bun.write(
    Bun.file(out),
    (await Bun.file(out).text().catch(() => "")) + `${key}<<${delim}\n${value}\n${delim}\n`,
  );
}

async function main(): Promise<void> {
  // Where `actions/download-artifact` unpacked `visual-evidence/`.
  const artifactDir = resolve(process.env.EVIDENCE_ARTIFACT_DIR ?? "artifact");
  const stageDir = resolve(process.env.EVIDENCE_STAGE_DIR ?? "evidence-stage");
  const commentFile = resolve(process.env.EVIDENCE_COMMENT_FILE ?? "comment-body.md");
  const repo = process.env.GITHUB_REPOSITORY ?? "ezcorp-org/EZCorp";
  // The publishing commit sha is filled in AFTER the orphan commit is made; the
  // workflow re-runs buildGalleryMarkdown with it. For the staging pass we use a
  // placeholder the workflow substitutes, but we still need the validated PR/run.
  const commitSha = process.env.EVIDENCE_COMMIT_SHA ?? "HEAD";

  // 1. Read + parse the manifest (fail-soft → ⚠️ comment, branch unknown).
  let manifest: ManifestShape = {};
  try {
    manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
  } catch {
    manifest = {};
  }

  let pr: number;
  try {
    pr = validatePrNumber(manifest.pr);
  } catch {
    // Without a valid PR number we cannot target a branch or comment — bail
    // soft so a publish error never reds anything.
    console.error("publish: manifest has no valid PR number; nothing to publish.");
    await emitOutput("pr", "");
    await emitOutput("branch", "");
    await emitOutput("shot_count", "0");
    return;
  }
  const runId = validatePrNumberSafe(manifest.runId);
  const headSha = sanitizeLabel(typeof manifest.headSha === "string" ? manifest.headSha : "");
  const branch = `evidence/pr-${pr}`;

  // 2. Validate + stage each shot. A shot is kept only if its file is a safe
  //    relative path AND decodes to real PNG bytes.
  const rawShots = Array.isArray(manifest.shots) ? manifest.shots : [];
  const staged: GalleryShot[] = [];
  // De-dupe staged paths so two shots whose spec/label reduce to the same safe
  // segments don't silently overwrite each other on disk / in the gallery.
  const seen = new Map<string, number>();
  await mkdir(stageDir, { recursive: true });
  for (const entry of rawShots) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file : "";
    if (!isSafeRelPath(file)) {
      console.error(`publish: dropping shot with unsafe path: ${JSON.stringify(file)}`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(artifactDir, file));
    } catch {
      console.error(`publish: dropping shot — file missing: ${file}`);
      continue;
    }
    if (!isPng(bytes)) {
      console.error(`publish: dropping shot — not a PNG: ${file}`);
      continue;
    }
    // spec + label reduced to single safe segments (no separators, no `.`/`..`),
    // then disambiguated on collision: "label", "label 2", "label 3", … — the
    // numeric suffix survives buildGalleryMarkdown's sanitize, so the rendered
    // URL stays === the on-disk path.
    // `rawSpec` keeps the ORIGINAL (pre-safeSegment) manifest spec so the P3
    // gallery partition can path-suffix-match it against the PR's changed spec
    // files — `spec` has already lost its `/` separators to `safeSegment`.
    const rawSpec = typeof e.spec === "string" ? e.spec : "evidence";
    const spec = safeSegment(rawSpec);
    const baseLabel = sanitizeLabel(typeof e.label === "string" ? e.label : "evidence");
    const key = `${spec}/${safeSegment(baseLabel)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const label = n === 1 ? baseLabel : `${baseLabel} ${n}`;
    const labelSeg = safeSegment(label);
    // On-branch layout: pr-<n>/<runId>/<spec>/<label>.png (matches gallery URL).
    const rel = join(`pr-${pr}`, String(runId), spec, `${labelSeg}.png`);
    if (!isSafeRelPath(rel)) continue;
    const abs = join(stageDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, bytes);
    staged.push({ spec, rawSpec, label, file: rel });
  }

  // 3. Emit the comment body + branch/pr/shot-count for the workflow. The
  //    OPTIONAL changed-spec list (from WF2's trusted diff fetch) partitions the
  //    gallery; absent/unreadable → full P1 layout (fail-soft, presentation only).
  const changedSpecs = await readChangedSpecPaths();
  // `skipped` is untrusted manifest data — honor it ONLY in the harmless
  // direction (zero staged shots → neutral update-only body). A hostile
  // manifest claiming skipped WITH shots still renders the normal gallery.
  const updateOnly = manifest.skipped === true && staged.length === 0;
  const body = updateOnly
    ? buildSkippedMarkdown()
    : buildGalleryMarkdown({
        repo,
        branch,
        commitSha,
        pr,
        runId,
        shots: staged,
        changedSpecs,
      });
  await Bun.write(commentFile, body);
  await emitOutput("pr", String(pr));
  await emitOutput("branch", branch);
  await emitOutput("shot_count", String(staged.length));
  await emitOutput("update_only", updateOnly ? "1" : "");
  await emitOutput("stage_dir", stageDir);
  await emitOutput("comment_file", commentFile);
  console.log(
    `publish: staged ${staged.length} shot(s) for PR #${pr} (head ${headSha || "?"}) → ${stageDir}`,
  );
}

/** runId is informational; tolerate garbage by falling back to 0. */
function validatePrNumberSafe(s: unknown): number {
  try {
    return validatePrNumber(s);
  } catch {
    return 0;
  }
}

/**
 * Read the OPTIONAL PR-diff file list (EVIDENCE_CHANGED_FILES → one repo-relative
 * path per line, written by WF2's trusted `gh api .../files` step) and reduce it
 * to the changed e2e spec paths. Absent env OR unreadable file → `undefined`, so
 * `buildGalleryMarkdown` renders the full P1 gallery. Fail-soft, UX-only: it only
 * reorders the gallery, never gates anything, and the file's contents are used
 * solely to float already-validated shots into the inline section.
 */
async function readChangedSpecPaths(): Promise<string[] | undefined> {
  const file = process.env.EVIDENCE_CHANGED_FILES;
  if (!file) return undefined;
  let content: string;
  try {
    content = await readFile(resolve(file), "utf8");
  } catch {
    console.error(
      `publish: EVIDENCE_CHANGED_FILES set but unreadable (${file}); rendering full gallery.`,
    );
    return undefined;
  }
  return parseChangedSpecPaths(content);
}

if (import.meta.main) {
  await main();
}
