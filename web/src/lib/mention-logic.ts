/**
 * Pure logic for mention trigger detection, token parsing, and insertion.
 * No UI dependencies — fully testable.
 *
 * Grammar:
 *   ![agent:Name]   ![ext:Name]   ![team:Name]   — resolved via DB / executor
 *   @[file:relative/path.ts]                     — project file references
 *   @[dir:relative/path]                         — project directory references
 *     (agent should read-all-files / write-into-folder for dir mentions)
 *   /[cmd:Name]                                  — slash-command expansions
 *     (discovered from .claude/.codex/agents dirs + userCommands DB)
 */

// Structured token regex: matches either `![kind:name]` (kind ∈ agent/ext/team),
// `@[file|dir:name]`, or `/[cmd:name]`. The three sigils are mutually exclusive.
// Capture groups:
//   1 = kind  (agent|ext|team)   when the ! alternative matches
//   2 = name  when the ! alternative matches
//   3 = kind  (file|dir)         when the @ alternative matches
//   4 = name  when the @ alternative matches
//   5 = kind  (cmd)              when the / alternative matches
//   6 = name  when the / alternative matches
export const MENTION_REGEX = /!\[(agent|ext|team):([^\]]+)\]|@\[(file|dir):([^\]]+)\]|\/\[(cmd):([^\]]+)\]/g;

export type MentionKind = "agent" | "ext" | "team" | "file" | "dir" | "cmd";

export interface MentionTrigger {
	active: boolean;
	query: string;
	/**
	 * For the `!` sigil, may be undefined (no explicit prefix) or the concrete
	 * kind when the user typed `!agent:` / `!ext:` / `!team:`.
	 * For the `@` sigil, always `"path"` — the popover shows mixed file + dir
	 * results. The search API uses this to route to the project-filesystem
	 * branch (returning entries whose concrete `kind` is `"file"` or `"dir"`).
	 * For the `/` sigil, always `"cmd"` — the popover shows slash commands.
	 */
	type?: "ext" | "agent" | "team" | "path" | "cmd";
	/** Which sigil activated the trigger. */
	sigil: "!" | "@" | "/";
}

export interface MentionToken {
	kind: MentionKind;
	name: string;
	start: number;
	end: number;
}

export type Segment =
	| { type: "text"; text: string }
	| { type: "mention"; kind: string; name: string; raw: string };

// Trigger regexes anchored to end-of-input-before-cursor.
// `!` captures an optional agent/ext/team: prefix and the query.
const BANG_TRIGGER_RE = /(?:^|\s)!((?:ext:|agent:|team:)?[^\s]*)$/;
// `@` is dedicated to file references; the whole non-space tail is the query.
const AT_TRIGGER_RE = /(?:^|\s)@([^\s]*)$/;
// `/` is dedicated to slash-command references; same tail semantics as `@`.
const SLASH_TRIGGER_RE = /(?:^|\s)\/([^\s]*)$/;

/**
 * Detect if the user is actively typing a mention trigger.
 * Returns null if neither `!` nor `@` is at a word boundary, or was dismissed
 * (whitespace after the sigil with nothing else).
 *
 * When both could theoretically match, the last sigil before the cursor wins
 * — because each pattern anchors to `$`, only the rightmost word-boundary
 * sigil can produce a match.
 */
export function detectMentionTrigger(
	value: string,
	cursorPos: number,
): MentionTrigger | null {
	const before = value.slice(0, cursorPos);

	// Try `!` first. Because both patterns anchor at `$`, at most one can match
	// for a given `before`, so order is not load-bearing for correctness — but
	// `!` is tried first to keep behavior deterministic and mirror the legacy
	// priority of agent/ext/team over file references.
	const bang = before.match(BANG_TRIGGER_RE);
	if (bang) {
		const raw = bang[1]!;
		if (raw.startsWith("ext:"))
			return { active: true, query: raw.slice(4), type: "ext", sigil: "!" };
		if (raw.startsWith("agent:"))
			return { active: true, query: raw.slice(6), type: "agent", sigil: "!" };
		if (raw.startsWith("team:"))
			return { active: true, query: raw.slice(5), type: "team", sigil: "!" };
		return { active: true, query: raw, type: undefined, sigil: "!" };
	}

	const at = before.match(AT_TRIGGER_RE);
	if (at) {
		// `@` triggers the path popover which contains BOTH files and dirs.
		// Server returns entries with their concrete kind (`file` or `dir`)
		// and the selection step inserts the matching structured token.
		return { active: true, query: at[1]!, type: "path", sigil: "@" };
	}

	const slash = before.match(SLASH_TRIGGER_RE);
	if (slash) {
		// `/` triggers the slash-command popover. The search API routes this
		// to the command registry (filesystem + DB sources).
		return { active: true, query: slash[1]!, type: "cmd", sigil: "/" };
	}

	return null;
}

/**
 * Extract all structured mention tokens from raw text.
 */
export function parseMentions(text: string): MentionToken[] {
	const mentions: MentionToken[] = [];
	const regex = new RegExp(MENTION_REGEX.source, "g");
	let match;
	while ((match = regex.exec(text)) !== null) {
		// Alternative 1 matched (! sigil, agent/ext/team)
		if (match[1] !== undefined) {
			mentions.push({
				kind: match[1] as "agent" | "ext" | "team",
				name: match[2]!,
				start: match.index,
				end: match.index + match[0].length,
			});
		} else if (match[3] !== undefined) {
			// Alternative 2 matched (@ sigil, file or dir)
			mentions.push({
				kind: match[3] as "file" | "dir",
				name: match[4]!,
				start: match.index,
				end: match.index + match[0].length,
			});
		} else if (match[5] !== undefined) {
			// Alternative 3 matched (/ sigil, cmd)
			mentions.push({
				kind: match[5] as "cmd",
				name: match[6]!,
				start: match.index,
				end: match.index + match[0].length,
			});
		}
	}
	return mentions;
}

/**
 * Replace the active trigger span (sigil + query) with a structured mention
 * token. The sigil used is derived from the target kind:
 *   kind === "file" | "dir"          → `@[kind:name] ` (path references)
 *   kind === "cmd"                   → `/[kind:name] ` (slash commands)
 *   kind === "agent" | "ext" | "team" → `![kind:name] ` (logical mentions)
 *
 * Returns new text and cursor position after the inserted token (including
 * the trailing space).
 */
export function insertMentionToken(
	value: string,
	cursorPos: number,
	mention: { kind: MentionKind; name: string },
): { text: string; cursor: number } {
	const before = value.slice(0, cursorPos);
	const isAtSigil = mention.kind === "file" || mention.kind === "dir";
	const isSlashSigil = mention.kind === "cmd";

	// Match the trigger span that corresponds to the target sigil. We inspect
	// the same underlying regex used for detection — the replacement only
	// succeeds if the user is actually in a trigger for this sigil.
	const triggerRe = isAtSigil
		? /(?:^|\s)@[^\s]*$/
		: isSlashSigil
		? /(?:^|\s)\/[^\s]*$/
		: /(?:^|\s)!(?:(?:ext:|agent:|team:)?[^\s]*)$/;
	const spanMatch = before.match(triggerRe);
	if (!spanMatch) return { text: value, cursor: cursorPos };

	// If the match starts with a whitespace character (because the sigil was
	// preceded by space/tab/newline rather than being at string start), skip
	// that char when computing the sigil position.
	const firstChar = spanMatch[0][0]!;
	const leadingWs = firstChar === " " || firstChar === "\t" || firstChar === "\n" ? 1 : 0;
	const atStart = before.length - spanMatch[0].length + leadingWs;

	const token = isAtSigil
		? `@[${mention.kind}:${mention.name}] `
		: isSlashSigil
		? `/[${mention.kind}:${mention.name}] `
		: `![${mention.kind}:${mention.name}] `;
	const after = value.slice(cursorPos);
	const newText = value.slice(0, atStart) + token + after;
	return { text: newText, cursor: atStart + token.length };
}

/**
 * Format a relative path for compact display in the mention popover.
 *
 * When the path is short (≤ `maxSegments` segments, default 2), returns it
 * unchanged. Otherwise middle-truncates it into `first/.../last` form so the
 * user can tell which top-level folder the entry lives under and which file
 * it resolves to, without the middle bloating the popover row.
 *
 * Examples (`maxSegments = 2`):
 *   "app.ts"                          → "app.ts"
 *   "src/app.ts"                      → "src/app.ts"
 *   "src/nested/deep.ts"              → "src/.../deep.ts"
 *   "a/b/c/d/e/leaf.ts"               → "a/.../leaf.ts"
 *
 * Leading / trailing / duplicate slashes are normalised out before counting
 * segments; preserving them in the output would confuse users about what
 * path actually got stored.
 */
export function formatPathDisplay(path: string, maxSegments: number = 2): string {
	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length <= maxSegments) return segments.join("/");
	return `${segments[0]}/.../${segments[segments.length - 1]}`;
}

/**
 * Rewrite the currently-active `@` trigger span to represent a folder-descent
 * (i.e., `@<folderPath>/`). Used by the mention popover when the user clicks
 * or Enters a folder entry — we rewrite the textarea so the next trigger
 * detection re-fires the search inside that folder instead of inserting a
 * token immediately.
 *
 * Behaviour:
 *   - preserves text before/after the trigger
 *   - always appends a trailing `/` (strips existing trailing slashes on the
 *     input path first, so the result has exactly one)
 *   - no-op if there's no `@` trigger at the cursor
 *
 * This is deliberately distinct from `insertMentionToken({kind:"dir", …})` —
 * descent is a navigation operation, not a commit.
 */
export function descendIntoFolder(
	value: string,
	cursorPos: number,
	folderPath: string,
): { text: string; cursor: number } {
	const before = value.slice(0, cursorPos);
	const spanMatch = before.match(/(?:^|\s)@[^\s]*$/);
	if (!spanMatch) return { text: value, cursor: cursorPos };

	const firstChar = spanMatch[0][0]!;
	const leadingWs = firstChar === " " || firstChar === "\t" || firstChar === "\n" ? 1 : 0;
	const atStart = before.length - spanMatch[0].length + leadingWs;

	const trimmed = folderPath.replace(/\/+$/, "");
	const insert = `@${trimmed}/`;
	const after = value.slice(cursorPos);
	const newText = value.slice(0, atStart) + insert + after;
	return { text: newText, cursor: atStart + insert.length };
}

/**
 * Split raw text into segments for overlay rendering.
 */
export function getSegments(text: string): Segment[] {
	const segments: Segment[] = [];
	const regex = new RegExp(MENTION_REGEX.source, "g");
	let lastIndex = 0;
	let match;

	while ((match = regex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
		}
		// Three alternatives in MENTION_REGEX — pick the capture pair that matched.
		let kind: string;
		let name: string;
		if (match[1] !== undefined) {
			kind = match[1]!;
			name = match[2]!;
		} else if (match[3] !== undefined) {
			kind = match[3]!;
			name = match[4]!;
		} else {
			kind = match[5]!;
			name = match[6]!;
		}
		segments.push({
			type: "mention",
			kind,
			name,
			raw: match[0],
		});
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		segments.push({ type: "text", text: text.slice(lastIndex) });
	}

	if (segments.length === 0 && text.length > 0) {
		segments.push({ type: "text", text });
	}

	return segments;
}
