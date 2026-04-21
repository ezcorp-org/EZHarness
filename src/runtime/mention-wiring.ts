import { parseMentions } from "../../web/src/lib/mention-logic";
import { getExtensionByName } from "../db/queries/extensions";
import { getAgentConfigByName, getAgentConfig } from "../db/queries/agent-configs";
import { getConversationExtensionIds, addConversationExtensions } from "../db/queries/conversation-extensions";
import { validatePath } from "./tools/validate";

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
  const seen = new Set<string>();
  const agents: Array<{ id: string; name: string; description: string }> = [];

  const mentions = parseMentions(messageContent);
  await Promise.all(mentions.map(async (mention) => {
    if (mention.kind !== "agent") return;
    const config = await getAgentConfigByName(mention.name);
    if (config && !seen.has(config.id)) {
      seen.add(config.id);
      agents.push({ id: config.id, name: config.name, description: config.description });
    }
  }));

  return agents;
}

/**
 * Resolve `![team:Name]` mentions to the team's agent config and its member agents.
 */
export async function resolveMentionedTeams(
  messageContent: string,
): Promise<Array<{ team: { id: string; name: string; description: string; prompt: string; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope }; members: Array<{ id: string; name: string; description: string }> }>> {
  const mentions = parseMentions(messageContent);
  const results: Array<{ team: { id: string; name: string; description: string; prompt: string; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope }; members: Array<{ id: string; name: string; description: string }> }> = [];
  const seen = new Set<string>();

  await Promise.all(mentions.map(async (mention) => {
    if (mention.kind !== "team") return;
    const config = await getAgentConfigByName(mention.name);
    if (!config || config.category !== "team" || seen.has(config.id)) return;
    seen.add(config.id);

    const refs = (config.references as { agents?: string[]; extensions?: string[]; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope } | null);
    const agentIds = refs?.agents ?? [];
    const members: Array<{ id: string; name: string; description: string }> = [];
    await Promise.all(agentIds.map(async (agentId) => {
      const member = await getAgentConfig(agentId);
      if (member) {
        members.push({ id: member.id, name: member.name, description: member.description });
      }
    }));

    results.push({
      team: { id: config.id, name: config.name, description: config.description, prompt: config.prompt, autoSpinUp: refs?.autoSpinUp ?? false, teamToolScope: refs?.teamToolScope },
      members,
    });
  }));

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

  const extensionIds = new Set<string>();

  await Promise.all(mentions.map(async (mention) => {
    if (mention.kind === "ext") {
      const ext = await getExtensionByName(mention.name);
      if (ext) extensionIds.add(ext.id);
    } else if (mention.kind === "agent") {
      const agent = await getAgentConfigByName(mention.name);
      if (agent) {
        const extIds = (agent.extensions as string[] | null) ?? [];
        for (const id of extIds) extensionIds.add(id);
      }
    }
  }));

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

/**
 * Resolve `@[file:…]` and `@[dir:…]` mentions against the active project root.
 *
 * Rejects:
 *   - absolute paths (`/etc/passwd` → skipped)
 *   - path traversal (`../../secret` → skipped via validatePath)
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
