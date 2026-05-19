import type { Message } from "$lib/api.js";

export type StreamSnapshotEntry = { content: string; thinking: string };
export type StreamSnapshot = Record<string, StreamSnapshotEntry>;

/**
 * Mirror the latest streaming text/thinking for `runId` into a page-local
 * snapshot map. Called inside an effect that watches the live cache values.
 *
 * Why this exists: `run:complete` synchronously calls `stopStreaming` which
 * wipes `store.streamingMessages[runId]` BEFORE the reconcile-after-stream
 * effect fires. Without a snapshot the reconcile sees an empty cache and
 * cannot back-fill an empty assistant row. Returns the same map reference
 * when nothing changed so callers' equality checks don't flip.
 *
 * Empty-string semantics: `streamingMessages[runId] = ""` is what
 * `run:turn_text_reset` sets between turns of a multi-turn run. We must NOT
 * clobber the previous turn's snapshot with `""` — the prior text is the
 * thing the post-stream reconcile may need to back-fill. So a non-empty
 * incoming value updates the snapshot; empty/undefined falls through to
 * whatever was last captured.
 */
export function recordSnapshot(
	snapshot: StreamSnapshot,
	runId: string | null,
	streamingText: string | undefined,
	streamingThinking: string | undefined,
): StreamSnapshot {
	if (!runId) return snapshot;
	if (streamingText === undefined && streamingThinking === undefined) return snapshot;

	const prev = snapshot[runId];
	const nextContent = streamingText && streamingText.length > 0
		? streamingText
		: prev?.content ?? "";
	const nextThinking = streamingThinking && streamingThinking.length > 0
		? streamingThinking
		: prev?.thinking ?? "";

	if (prev && prev.content === nextContent && prev.thinking === nextThinking) {
		return snapshot;
	}
	return { ...snapshot, [runId]: { content: nextContent, thinking: nextThinking } };
}

/** Drop one entry from a snapshot. Same-reference fast path when absent. */
export function clearSnapshot(snapshot: StreamSnapshot, runId: string | null): StreamSnapshot {
	if (!runId || !(runId in snapshot)) return snapshot;
	const { [runId]: _, ...rest } = snapshot;
	return rest;
}

/**
 * Build the cache-shaped maps from a snapshot for a given runId. Used at the
 * call site so we hand `patchAssistantContentFromStream` the same shape it
 * already accepts (no API change to the pure helper).
 */
export function snapshotToMaps(
	snapshot: StreamSnapshot,
	runId: string | null,
): { contentMap: Record<string, string>; thinkingMap: Record<string, string> } {
	if (!runId) return { contentMap: {}, thinkingMap: {} };
	const entry = snapshot[runId];
	if (!entry) return { contentMap: {}, thinkingMap: {} };
	return {
		contentMap: entry.content ? { [runId]: entry.content } : {},
		thinkingMap: entry.thinking ? { [runId]: entry.thinking } : {},
	};
}

/**
 * Back-fill the LAST assistant message of a run with text from the streaming
 * cache when the persisted row came back empty.
 *
 * Why "last" only: a single run can persist multiple assistant turns —
 * intermediate ones (memory fetch, tool-only turns) legitimately have empty
 * content with their meaning encoded in tool calls / memoriesUsed that
 * hydrate separately. If we patched every empty row with the same runId we'd
 * duplicate the final turn's text into earlier intermediate turns. Only the
 * LAST one (which is what the user just saw streaming) is the candidate.
 *
 * If the last assistant row is already populated, no patch occurs even if
 * earlier rows are empty.
 */
export function patchAssistantContentFromStream(
	messages: Message[],
	runId: string | null,
	streamingMessages: Record<string, string>,
	streamingThinking: Record<string, string>,
): Message[] {
	if (!runId) return messages;

	let lastIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.runId === runId && m.role === "assistant") { lastIdx = i; break; }
	}
	if (lastIdx < 0) return messages;

	const target = messages[lastIdx]!;
	const needsContent = !target.content?.trim() && !!streamingMessages[runId];
	const needsThinking = !target.thinkingContent && !!streamingThinking[runId];
	if (!needsContent && !needsThinking) return messages;

	const result = messages.slice();
	result[lastIdx] = {
		...target,
		...(needsContent ? { content: streamingMessages[runId]! } : {}),
		...(needsThinking ? { thinkingContent: streamingThinking[runId]! } : {}),
	};
	return result;
}
