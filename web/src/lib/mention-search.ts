import { searchMentions } from "$lib/api";
import type { MentionItem } from "$lib/components/MentionPopover.svelte";

/** Search mentions and shape the results for MentionPopover (both composers). */
export async function searchMentionItems(
	query: string,
	type: Parameters<typeof searchMentions>[1],
	projectId: string | undefined,
): Promise<MentionItem[]> {
	const results = await searchMentions(query, type, projectId);
	return results.map((r) => ({
		name: r.name,
		description: r.description,
		kind: r.kind,
		source: r.source,
		fileCount: r.fileCount,
		insertText: r.insertText,
	}));
}
