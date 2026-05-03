import { realpath } from "node:fs/promises";
import { parseMentions, STRUCTURED_NAME_CHAR_CLASS } from "../../web/src/lib/mention-logic";
import { getExtensionsByNames } from "../db/queries/extensions";
import { getAgentConfigsByNames, getAgentConfigsByIds } from "../db/queries/agent-configs";
import { getConversationExtensionIds, addConversationExtensions } from "../db/queries/conversation-extensions";
import { validatePath } from "./tools/validate";
import { realpathInsideRoot } from "./fs/scan-fs";

// ─── Slash-command expansion ───────────────────────────────────────

/**
 * Resolves a slash-command name to its body + frontmatter, or null if no
 * such command exists in the user/project/host scope.
 */
export type CommandResolver = (
  name: string,
) => Promise<{ body: string; frontmatter?: Record<string, string> } | null>;

export interface ExpandedCommands {
  /** Message text with `/[cmd:name]` tokens replaced by their rendered bodies. */
  expanded: string;
  /** Optional advisory notes (unknown command, routed agent) for the executor. */
  systemNotes: string[];
}

const ARGS_PLACEHOLDER_RE = /\$ARGUMENTS|\$\d+/;

/**
 * Substitute `$ARGUMENTS`, `$1..$N` in `body` using the free-text args
 * that followed the command token. `args` is the raw inter-token text;
 * only the leading separator whitespace is stripped (so any trailing
 * space carried over from the original message survives into the output
 * and separates this command from the next token).
 */
function substituteArgs(body: string, args: string): string {
  const ltrimmed = args.replace(/^\s+/, "");
  const trimmed = ltrimmed.trimEnd();
  const positional = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  return body
    .replace(/\$ARGUMENTS/g, ltrimmed)
    .replace(/\$(\d+)/g, (_m, idx: string) => {
      const i = parseInt(idx, 10);
      return i >= 1 && i <= positional.length ? positional[i - 1]! : "";
    });
}

/**
 * Expand `/[cmd:…]` tokens in `content` into their command bodies with
 * `$ARGUMENTS` / `$N` substituted from text following each token.
 *
 * Expansion is **literal**: the rendered body is not re-parsed for
 * further mention tokens. This prevents indirect prompt-injection where
 * a command body (or user-supplied `$ARGUMENTS`) contains strings like
 * `![ext:evil]` that would otherwise trigger tool wiring downstream.
 *
 * Callers should persist the ORIGINAL message and pass only the
 * `expanded` return value to the LLM. `systemNotes` surfaces advisory
 * info (unknown command, frontmatter `agent:` routing hints).
 */
// fallow-ignore-next-line unused-export
export async function expandCommandMentions(
  content: string,
  resolver: CommandResolver,
): Promise<ExpandedCommands> {
  const mentions = parseMentions(content);
  const cmdMentions = mentions.filter((m) => m.kind === "cmd");
  if (cmdMentions.length === 0) {
    return { expanded: content, systemNotes: [] };
  }

  const systemNotes: string[] = [];
  const segments: string[] = [];
  let cursor = 0;

  for (let i = 0; i < cmdMentions.length; i++) {
    const mention = cmdMentions[i]!;
    // Text before this token passes through unchanged.
    if (mention.start > cursor) {
      segments.push(content.slice(cursor, mention.start));
    }

    // Args text = everything from end of this token up to the start of
    // the NEXT command token (or end-of-string). Non-command tokens
    // inside that slice are passed through untouched — they stay as
    // literal text post-expansion, which is why `expansion is literal`.
    const next = cmdMentions[i + 1];
    const argsEnd = next ? next.start : content.length;
    const rawArgs = content.slice(mention.end, argsEnd);

    const resolved = await resolver(mention.name);
    if (!resolved) {
      systemNotes.push(
        `Unknown slash command: /${mention.name} — token left as literal text.`,
      );
      // Leave token + args intact so the user sees what they typed.
      segments.push(content.slice(mention.start, argsEnd));
      cursor = argsEnd;
      continue;
    }

    // If the body doesn't reference `$ARGUMENTS` or `$N`, the inter-token
    // text (rawArgs) is not consumed — it passes through as prose so a
    // sentence like "`/a` and `/b`" retains the " and " in between.
    if (ARGS_PLACEHOLDER_RE.test(resolved.body)) {
      segments.push(substituteArgs(resolved.body, rawArgs));
    } else {
      segments.push(resolved.body + rawArgs);
    }

    if (resolved.frontmatter?.agent) {
      systemNotes.push(
        `[Command /${mention.name} requests routing to agent: ${resolved.frontmatter.agent}]`,
      );
    }

    cursor = argsEnd;
  }

  // Trailing text (after the last command + its args) — only reachable
  // when the loop's last iteration already captured args up to the
  // content end, so this is a safety no-op in practice.
  if (cursor < content.length) {
    segments.push(content.slice(cursor));
  }

  return { expanded: segments.join(""), systemNotes };
}

/**
 * Small adapter that runs `expandCommandMentions` and returns the final
 * prompt string the LLM should see. When expansion produced system
 * notes, they're prepended as a plain-text pre-amble so the LLM has
 * context for what the commands mean (e.g. "Unknown slash command: /x").
 *
 * Extracted from `executor.streamChat` so it's directly unit-testable —
 * the executor is too tangled to exercise end-to-end in a unit test, but
 * this transform is the part that matters for correctness.
 */
export async function applyCommandExpansion(
  userMessage: string,
  resolver: CommandResolver,
): Promise<string> {
  const { expanded, systemNotes } = await expandCommandMentions(
    userMessage,
    resolver,
  );
  // Short-circuit only when *nothing* needed to change — same text AND
  // no advisory notes to surface. Otherwise an unknown-command message
  // (which leaves `expanded === userMessage` but still carries a
  // system note) would never be surfaced to the LLM.
  if (expanded === userMessage && systemNotes.length === 0) {
    return userMessage;
  }
  const notes = systemNotes.length > 0 ? systemNotes.join("\n") + "\n\n" : "";
  return notes + expanded;
}

// ─── Feature-mention expansion ─────────────────────────────────────

/**
 * Resolves a `$[feature:name]` token to the feature's description and
 * file list (project-relative paths). `null` for unknown / deleted
 * features — caller MUST treat that as a silent no-op (mirroring how
 * `@[file:…]` handles a deleted file).
 *
 * The resolver pattern matches `CommandResolver` so this module stays
 * DB-free and unit-testable in isolation. The build-prompt path
 * supplies a real DB-backed resolver via `getFeature(projectId, name)`.
 */
export type FeatureResolver = (
  name: string,
) => Promise<{ description: string; files: string[] } | null>;

/**
 * Standalone token regex for `$[feature:name]`. Lives here (instead of
 * piggy-backing on `parseMentions` from web/src/lib/mention-logic.ts)
 * so this module's expansion is decoupled from the front-end picker
 * wiring — `applyFeatureExpansion` works correctly even before the
 * composer regex grows the `$` sigil. The two will agree at every
 * point in time because the name char class is sourced from the
 * shared `STRUCTURED_NAME_CHAR_CLASS` constant in mention-logic.ts
 * (audit defect C12 close-out — eliminates the drift risk between
 * MENTION_REGEX and this regex).
 *
 * The shared char class matches any non-`]` chars; the parser strips
 * whitespace and skips empty names. The `g` flag is ON via the local
 * copy in the loop — the exported `source` is reusable.
 */
export const FEATURE_TOKEN_RE = new RegExp(
  `\\$\\[feature:(${STRUCTURED_NAME_CHAR_CLASS})\\]`,
  "g",
);

/**
 * Expand `$[feature:<name>]` tokens in `userMessage` into a system-note
 * block per resolved feature.
 *
 * Returns the JOINED system-note text (or `""` when no tokens / no
 * resolvable features). The caller is responsible for prepending the
 * result to the prompt — the user-visible message text is NEVER
 * modified by this function. That mirrors `@[file:…]` resolution:
 * the raw token survives in the persisted message, while the LLM
 * sees an additional system note.
 *
 * Critical correctness rules (per design doc §4):
 *   - Files are emitted as PLAIN TEXT (`- src/foo.ts`), NOT as
 *     `@[file:…]` tokens. No double-expansion: any other mention
 *     sigil that happens to live inside a feature description or
 *     file path is left untouched downstream.
 *   - Unknown / deleted features → silent no-op. The token text
 *     stays in the user message; no system note is generated.
 *   - Duplicate tokens (`$[feature:x]` twice) emit ONE block per
 *     feature. Order is the source order of first occurrence.
 */
export async function applyFeatureExpansion(
  userMessage: string,
  resolver: FeatureResolver,
): Promise<string> {
  // Walk tokens in source order, dedupe by name. Using a fresh regex
  // instance per call keeps `lastIndex` from leaking across calls.
  const re = new RegExp(FEATURE_TOKEN_RE.source, "g");
  const seen = new Set<string>();
  const orderedNames: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(userMessage)) !== null) {
    const name = m[1]!.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    orderedNames.push(name);
  }
  if (orderedNames.length === 0) return "";

  const blocks: string[] = [];
  for (const name of orderedNames) {
    const f = await resolver(name);
    if (!f) continue; // unknown / deleted → silent no-op
    if (f.files.length === 0) {
      // Description-only block. The "Look at and modify these files"
      // sentence reads as a contradiction with no list, so we omit it.
      blocks.push(`**Feature: ${name}**\n${f.description}`);
      continue;
    }
    const filesList = f.files.map((p) => `- ${p}`).join("\n");
    blocks.push(
      `**Feature: ${name}**\n${f.description}. Look at and modify these files first when working on this feature:\n${filesList}`,
    );
  }
  return blocks.join("\n\n");
}

// ─── Lesson-mention expansion ──────────────────────────────────────

/**
 * Resolves a `%[lesson:slug]` token to the lesson's title + body and
 * the underlying lesson row id (so callers can bump
 * `firedCount` / `lastFiredAt` after a successful expansion).
 *
 * `null` for unknown / deleted slugs — caller MUST treat that as a
 * silent no-op (mirroring how `$[feature:…]` and `@[file:…]` handle
 * a missing target).
 *
 * The resolver pattern matches `FeatureResolver` so this module stays
 * DB-free and unit-testable. The build-prompt path supplies a real
 * DB-backed resolver via `getLessonBySlug(projectId, ownerId, slug)`.
 */
export type LessonResolver = (
  slug: string,
) => Promise<{ title: string; body: string; lessonId: string } | null>;

/**
 * Standalone token regex for `%[lesson:slug]`. Mirrors `FEATURE_TOKEN_RE`
 * — sourced from the shared `STRUCTURED_NAME_CHAR_CLASS` constant in
 * mention-logic.ts so this module's expansion never drifts from the
 * front-end picker regex.
 */
export const LESSON_TOKEN_RE = new RegExp(
  `\\%\\[lesson:(${STRUCTURED_NAME_CHAR_CLASS})\\]`,
  "g",
);

/**
 * Hard caps on lesson expansion within a single user turn.
 *
 * Per the scout review (tasks/lessons-keeper-v1.md, Q-decisions): a
 * single message may contain at most {@link MAX_LESSON_EXPANSIONS_PER_TURN}
 * `%[lesson:…]` tokens and the cumulative expanded text may not exceed
 * {@link MAX_LESSON_EXPANDED_CHARS} characters. Excess tokens are
 * dropped silently — fail closed so a paste-bomb cannot DoS the
 * prompt by stuffing the context window with lesson bodies.
 *
 * Caps are applied AFTER dedupe so a duplicated slug only consumes one
 * slot (matches the per-feature dedupe contract in
 * `applyFeatureExpansion`).
 */
const MAX_LESSON_EXPANSIONS_PER_TURN = 5;
// 8 KiB measured as JS string length — i.e. UTF-16 code units, NOT bytes
// or grapheme clusters. Multi-byte UTF-8 chars (CJK ~3 B, emoji ~4 B)
// produce a larger downstream payload than this number suggests, so
// treat it as a soft "context-window units" budget rather than a strict
// byte ceiling. If a hard byte cap is ever needed, swap to
// `Buffer.byteLength(block, "utf8")`.
const MAX_LESSON_EXPANDED_CHARS = 8 * 1024;

/**
 * Expand `%[lesson:<slug>]` tokens in `userMessage` into a system-note
 * block per resolved lesson.
 *
 * Returns the JOINED system-note text (or `""` when no tokens / no
 * resolvable lessons). The caller is responsible for prepending the
 * result to the prompt — the user-visible message text is NEVER
 * modified by this function, mirroring `applyFeatureExpansion`.
 *
 * Critical correctness rules:
 *   - Tokens are walked in source order, deduped by slug — a slug
 *     repeated three times produces ONE block and ONE `onFired` call.
 *   - Unknown / deleted slugs → silent no-op (no system note, no
 *     `onFired` call).
 *   - Per-turn cap (`MAX_LESSON_EXPANSIONS_PER_TURN`): at most 5
 *     blocks emitted; further unique slugs dropped silently.
 *   - Total-byte cap (`MAX_LESSON_EXPANDED_CHARS`): once the joined
 *     blocks would exceed 8 KB, further blocks are dropped silently.
 *     The check is "would-exceed" — a partially-fitting block is
 *     dropped whole (we never truncate a body mid-sentence).
 *   - `onFired` invokes once per *successfully included* lesson with
 *     the lesson's `lessonId`. Callers use it to bump
 *     `firedCount` / `lastFiredAt`. Pass `undefined` from tests that
 *     don't need the signal.
 *   - No double-expansion: lesson bodies are emitted VERBATIM. Any
 *     other mention sigil (`![ext:…]`, `@[file:…]`, `$[feature:…]`)
 *     that appears inside a body stays literal.
 */
export async function applyLessonExpansion(
  userMessage: string,
  resolver: LessonResolver,
  onFired?: (lessonId: string) => void,
): Promise<string> {
  // Walk tokens in source order, dedupe by slug. Fresh regex per call
  // so `lastIndex` doesn't leak between invocations.
  const re = new RegExp(LESSON_TOKEN_RE.source, "g");
  const seen = new Set<string>();
  const orderedSlugs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(userMessage)) !== null) {
    const slug = m[1]!.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    orderedSlugs.push(slug);
  }
  if (orderedSlugs.length === 0) return "";

  const blocks: string[] = [];
  let totalChars = 0;
  for (const slug of orderedSlugs) {
    // Per-turn count cap — applied AFTER dedupe (each unique slug
    // consumes one slot, regardless of how many times it appeared).
    if (blocks.length >= MAX_LESSON_EXPANSIONS_PER_TURN) break;

    const lesson = await resolver(slug);
    if (!lesson) continue; // unknown / deleted → silent no-op

    const block = `**Lesson: ${lesson.title}**\n${lesson.body}`;
    // Joined output cost = previous-blocks + "\n\n" separator (when
    // there is a previous block) + this block. Use that exact size
    // as the would-exceed check so the cap reflects what the LLM
    // actually sees post-`join("\n\n")`.
    const separatorCost = blocks.length > 0 ? 2 : 0;
    if (totalChars + separatorCost + block.length > MAX_LESSON_EXPANDED_CHARS) {
      // Drop this whole block — no partial-truncation. Subsequent
      // blocks will also fail the check (they'd still need the
      // separator), so break early to avoid pointless resolver work.
      break;
    }
    blocks.push(block);
    totalChars += separatorCost + block.length;
    onFired?.(lesson.lessonId);
  }
  return blocks.join("\n\n");
}

/**
 * Parse structured `![agent:Name]` mentions from a message and resolve them
 * to agent config records.
 *
 * NOTE: the old bareword `@Name` fallback has been removed. `@` is now the
 * sigil for file references (`@[file:path]`), so bareword `@Name` no longer
 * resolves to an agent. Agents must be addressed via the structured form
 * `![agent:Name]`.
 */
export async function resolveMentionedAgents(
  messageContent: string,
): Promise<Array<{ id: string; name: string; description: string }>> {
  const mentions = parseMentions(messageContent);
  // Pre-collect agent names in source order; the Set passed to
  // getAgentConfigsByNames dedupes the round-trip but we still want to
  // walk `mentions` to preserve user-authored order in the result.
  const agentNames = mentions.filter((m) => m.kind === "agent").map((m) => m.name);
  if (agentNames.length === 0) return [];

  const byName = await getAgentConfigsByNames(agentNames);

  const seen = new Set<string>();
  const agents: Array<{ id: string; name: string; description: string }> = [];
  for (const mention of mentions) {
    if (mention.kind !== "agent") continue;
    const config = byName.get(mention.name);
    if (config && !seen.has(config.id)) {
      seen.add(config.id);
      agents.push({ id: config.id, name: config.name, description: config.description });
    }
  }
  return agents;
}

/**
 * Resolve `![team:Name]` mentions to the team's agent config and its member agents.
 */
export async function resolveMentionedTeams(
  messageContent: string,
): Promise<Array<{ team: { id: string; name: string; description: string; prompt: string; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope }; members: Array<{ id: string; name: string; description: string }> }>> {
  const mentions = parseMentions(messageContent);
  const teamNames = mentions.filter((m) => m.kind === "team").map((m) => m.name);
  if (teamNames.length === 0) return [];

  // Round-trip 1: resolve all team-name mentions to configs in one query.
  const teamConfigByName = await getAgentConfigsByNames(teamNames);

  // Walk mentions in source order, filter to category === "team", dedupe
  // by config.id. Collect every member agentId across all teams so we can
  // batch-fetch member configs in a single round trip.
  const seenTeamIds = new Set<string>();
  const teamRecords: Array<{
    config: typeof teamConfigByName extends Map<string, infer V> ? V : never;
    refs: { agents?: string[]; extensions?: string[]; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope } | null;
  }> = [];
  const allMemberIds: string[] = [];
  for (const mention of mentions) {
    if (mention.kind !== "team") continue;
    const config = teamConfigByName.get(mention.name);
    if (!config || config.category !== "team" || seenTeamIds.has(config.id)) continue;
    seenTeamIds.add(config.id);
    const refs = config.references as { agents?: string[]; extensions?: string[]; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope } | null;
    teamRecords.push({ config, refs });
    for (const id of refs?.agents ?? []) allMemberIds.push(id);
  }

  // Round-trip 2: resolve every member id across every mentioned team in
  // one query. Empty input short-circuits to an empty map.
  const memberById = await getAgentConfigsByIds(allMemberIds);

  const results: Array<{ team: { id: string; name: string; description: string; prompt: string; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope }; members: Array<{ id: string; name: string; description: string }> }> = [];
  for (const { config, refs } of teamRecords) {
    const members: Array<{ id: string; name: string; description: string }> = [];
    for (const agentId of refs?.agents ?? []) {
      const member = memberById.get(agentId);
      if (member) {
        members.push({ id: member.id, name: member.name, description: member.description });
      }
    }
    results.push({
      team: { id: config.id, name: config.name, description: config.description, prompt: config.prompt, autoSpinUp: refs?.autoSpinUp ?? false, teamToolScope: refs?.teamToolScope },
      members,
    });
  }
  return results;
}

/**
 * Parse mentions from a message and wire the referenced extensions into the
 * conversation so their tools become available.
 */
export async function wireMentionedExtensions(
  conversationId: string,
  messageContent: string,
  messageId: string,
): Promise<string[]> {
  const mentions = parseMentions(messageContent);
  if (mentions.length === 0) return [];

  // Pre-collect every name we need to look up so each kind makes a single
  // round trip regardless of mention count. The two queries (extensions
  // by name, agents by name) run in parallel.
  const extNames = mentions.filter((m) => m.kind === "ext").map((m) => m.name);
  const agentNames = mentions.filter((m) => m.kind === "agent").map((m) => m.name);
  if (extNames.length === 0 && agentNames.length === 0) return [];

  const [extByName, agentByName] = await Promise.all([
    getExtensionsByNames(extNames),
    getAgentConfigsByNames(agentNames),
  ]);

  const extensionIds = new Set<string>();
  for (const mention of mentions) {
    if (mention.kind === "ext") {
      const ext = extByName.get(mention.name);
      if (ext) extensionIds.add(ext.id);
    } else if (mention.kind === "agent") {
      const agent = agentByName.get(mention.name);
      if (agent) {
        const extIds = (agent.extensions as string[] | null) ?? [];
        for (const id of extIds) extensionIds.add(id);
      }
    }
  }

  if (extensionIds.size === 0) return [];

  const existing = new Set(await getConversationExtensionIds(conversationId));
  const newIds = [...extensionIds].filter(id => !existing.has(id));

  if (newIds.length === 0) return [];

  await addConversationExtensions(
    conversationId,
    newIds.map(extensionId => ({ extensionId, messageId })),
  );

  return newIds;
}

// ─── Path mentions (files + directories) ───────────────────────────

export interface ResolvedFileMention {
  /** Whether the user referenced a file or a directory. */
  kind: "file" | "dir";
  /** The relative path as authored in the token. */
  relPath: string;
  /** Absolute path on disk after resolving against projectPath. */
  absPath: string;
  /**
   * Whether the path exists AND matches its claimed kind:
   *   - kind="file" → path exists and is a regular file
   *   - kind="dir"  → path exists and is a directory
   */
  exists: boolean;
}

async function pathExistsAsKind(
  absPath: string,
  kind: "file" | "dir",
): Promise<boolean> {
  // Bun.file(x).exists() returns true only for regular files. For directories
  // we use Bun's statSync-equivalent via node:fs/promises — per project policy
  // we prefer Bun.file for file existence, but directory detection isn't in
  // Bun's public API, so fall back to statSync (sync) via a light wrapper.
  if (kind === "file") return Bun.file(absPath).exists();
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(absPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Symlink-escape predicate is shared with the autocomplete + scanner via
// runtime/fs/scan-fs::realpathInsideRoot. Locally aliased so the call
// site below reads the same as before the refactor.
const isInsideRoot = realpathInsideRoot;

/**
 * Resolve `@[file:…]` and `@[dir:…]` mentions against the active project root.
 *
 * Rejects:
 *   - absolute paths (`/etc/passwd` → skipped)
 *   - path traversal (`../../secret` → skipped via validatePath)
 *   - symlink-escape (an existing path whose realpath resolves outside
 *     the project root → skipped via `isInsideRoot`)
 *
 * Returns an empty array when `projectPath` is not provided. Duplicate
 * (kind, relPath) pairs are deduplicated.
 */
export async function resolveFileMentions(
  messageContent: string,
  projectPath?: string,
): Promise<ResolvedFileMention[]> {
  if (!projectPath) return [];

  const mentions = parseMentions(messageContent);
  const pathMentions = mentions.filter(
    (m) => m.kind === "file" || m.kind === "dir",
  );
  if (pathMentions.length === 0) return [];

  // Resolve project root once via realpath so symlink-escape confinement
  // compares against the canonical root, not a passed-in path that could
  // itself contain symlinks. If the root fails to resolve, refuse all
  // mentions — we can't enforce the boundary.
  let realRoot: string;
  try {
    realRoot = await realpath(projectPath);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const resolved: ResolvedFileMention[] = [];

  for (const mention of pathMentions) {
    const kind = mention.kind as "file" | "dir";
    const rel = mention.name.trim().replace(/\/+$/, ""); // strip trailing slash(es) on dirs
    if (rel.length === 0) continue;
    // Absolute paths are rejected — mentions must be project-relative.
    if (rel.startsWith("/")) continue;
    const key = `${kind}:${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let absPath: string;
    try {
      absPath = validatePath(projectPath, rel);
    } catch {
      // Path traversal — skip rather than throw so one bad mention doesn't
      // poison the whole turn.
      continue;
    }

    const exists = await pathExistsAsKind(absPath, kind);
    // Symlink-escape confinement: an existing path whose realpath resolves
    // outside the project root is refused. Non-existent paths are kept
    // (with exists=false) — they can't leak read content, and validatePath
    // already blocks `..`/absolute traversal at the string layer.
    if (exists && !(await isInsideRoot(realRoot, absPath))) continue;

    resolved.push({ kind, relPath: rel, absPath, exists });
  }

  return resolved;
}

/**
 * Format resolved file/dir mentions into a plain-text system note the executor
 * can prepend to the conversation turn. The agent can then choose to load the
 * file via `readFile` or list/read the directory via `listFiles` / `readFile`
 * per entry — no content is embedded here (lazy injection).
 *
 * Distinct wording per kind so the agent knows whether to read a single file
 * or treat the path as a target for listing / storing new files.
 *
 * Returns an empty string when there are no mentions, so callers can
 * unconditionally concatenate the result.
 */
export function formatFileMentionSystemNotes(
  mentions: ResolvedFileMention[],
): string {
  if (mentions.length === 0) return "";
  return mentions
    .map((m) => {
      const status = m.exists ? "" : " (not found)";
      if (m.kind === "dir") {
        return `[User referenced directory: ${m.relPath} at ${m.absPath}${status} — agent may list files here or treat as a target for new files]`;
      }
      return `[User referenced file: ${m.relPath} at ${m.absPath}${status}]`;
    })
    .join("\n");
}
