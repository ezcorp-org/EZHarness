import type { Message } from "$lib/api.js";

/**
 * Add root-level capability audit rows to an already selected conversation
 * branch. The branch order is authoritative: ancestry can be meaningful even
 * when fixture or imported timestamps are out of order. Capability rows are
 * appended in the API's native order and never duplicated.
 */
export function appendCapabilityAnnotations<T extends Message>(
	branch: readonly T[],
	allMessages: readonly T[],
): T[] {
	const seen = new Set(branch.map((message) => message.id));
	const annotations: T[] = [];
	for (const message of allMessages) {
		// Production writes are root-level. A parented capability row belongs to
		// that branch and reaches it through pathToRoot; never append one from a
		// different branch as a global annotation.
		if (
			message.role !== "capability-event" ||
			message.parentMessageId !== null ||
			seen.has(message.id)
		) continue;
		seen.add(message.id);
		annotations.push(message);
	}
	return annotations.length === 0 ? [...branch] : [...branch, ...annotations];
}
