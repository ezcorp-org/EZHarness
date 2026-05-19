import type { Message } from "$lib/api.js";
import {
	patchAssistantContentFromStream,
	snapshotToMaps,
	clearSnapshot,
	type StreamSnapshot,
} from "./reconcile-stream.js";

/**
 * Host the reconcile logic depends on. Mirrors the field-injection pattern
 * stream-resume.svelte.ts uses so the page can pass `$state` getters/setters
 * and tests can pass plain mutable refs without standing up runes.
 */
export interface ReconcileHost {
	convId: () => string;
	activeRunId: { get: () => string | null; set: (v: string | null) => void };
	activeRunStartedAt: { set: (v: number | null) => void };
	serverStalenessMs: { set: (v: number | null) => void };
	allMessages: { get: () => Message[]; set: (v: Message[]) => void };
	activeLeafId: { get: () => string | null; set: (v: string | null) => void };
	streamedSnapshot: { get: () => StreamSnapshot; set: (v: StreamSnapshot) => void };
	fetchAllMessages: (convId: string) => Promise<Message[]>;
	computeLatestLeaf: (messages: Message[]) => string | null;
	hydrateToolCallsFromApi: () => Promise<void>;
}

/**
 * Body of `reconcileAfterStream` extracted so it can be unit-tested. Captures
 * the runId BEFORE clearing it (mirrors the original page semantics), uses the
 * page-local `streamedSnapshot` (which survives `stopStreaming`'s cache wipe)
 * to back-fill empty assistant content, and cleans up the snapshot entry on
 * the way out.
 */
export async function runReconcileAfterStream(host: ReconcileHost): Promise<void> {
	const runId = host.activeRunId.get();
	host.activeRunId.set(null);
	host.activeRunStartedAt.set(null);
	host.serverStalenessMs.set(null);

	const { contentMap, thinkingMap } = snapshotToMaps(host.streamedSnapshot.get(), runId);

	try {
		const freshMessages = await host.fetchAllMessages(host.convId());
		host.allMessages.set(
			patchAssistantContentFromStream(freshMessages, runId, contentMap, thinkingMap),
		);
		const leaf = host.activeLeafId.get();
		if (leaf) {
			if (!freshMessages.find((m) => m.id === leaf)) {
				host.activeLeafId.set(host.computeLatestLeaf(freshMessages));
			}
		} else {
			host.activeLeafId.set(host.computeLatestLeaf(freshMessages));
		}
		await host.hydrateToolCallsFromApi();
	} catch {
		host.allMessages.set(
			patchAssistantContentFromStream(host.allMessages.get(), runId, contentMap, thinkingMap),
		);
	} finally {
		host.streamedSnapshot.set(clearSnapshot(host.streamedSnapshot.get(), runId));
	}
}
