/**
 * Cross-project palette grouping (Phase 67 — Command Palette Search, plan 05).
 *
 * One level deeper than Phase 66's per-conversation grouping: the Cmd+K
 * palette searches across the user's whole project set (PAL-01), so hits must
 * be grouped project → conversation → message. This pure helper builds the
 * render tree (sections → groups → rows) plus a parallel flat list of the
 * actionable rows ONLY (commands + hits, never headers) for keyboard nav.
 *
 * Section order is locked by 67-CONTEXT: Commands → In this conversation →
 * Other (when a conversation is active); Commands → Messages (when none is).
 * Empty sections are omitted. The flat list is built in the SAME pass as the
 * render tree so `flatItems[i]` is identity-equal to the row that renders at
 * that position — that identity is what drives arrow-key navigation in
 * CommandPalette.svelte (indexOf the focused row → its flat index).
 *
 * Conversation grouping within a project REUSES `groupHitsByConversation`
 * (search-mode.ts) rather than re-deriving it — preserving its first-seen
 * order semantics (PAL-03). `Command` / `MessageSearchHit` are imported from
 * their owning modules, never redefined.
 */
import type { MessageSearchHit } from "$lib/api.js";
import type { Command } from "$lib/command-registry";
import { groupHitsByConversation } from "./search-mode.js";

export type PaletteRow =
	| { kind: "command"; command: Command }
	| { kind: "hit"; hit: MessageSearchHit };

export type PaletteGroup = {
	projectId?: string;
	projectName?: string;
	conversationId?: string;
	conversationTitle?: string;
	rows: PaletteRow[];
};

export type PaletteSection = { id: string; label: string; groups: PaletteGroup[] };

export type PaletteResults = {
	sections: PaletteSection[];
	flatItems: (Command | MessageSearchHit)[];
};

/**
 * Group a flat hit list into project → conversation groups, preserving
 * first-seen project order and (via `groupHitsByConversation`) first-seen
 * conversation order within each project. Each emitted `PaletteGroup` is a
 * single (project, conversation) pair carrying its names/titles + hit rows.
 */
function groupHitsByProjectConversation(hits: MessageSearchHit[]): PaletteGroup[] {
	// First-seen project order.
	const byProject = new Map<string, MessageSearchHit[]>();
	for (const h of hits) {
		const bucket = byProject.get(h.projectId);
		if (bucket) bucket.push(h);
		else byProject.set(h.projectId, [h]);
	}

	const groups: PaletteGroup[] = [];
	for (const [projectId, projectHits] of byProject) {
		// Reuse first-seen conversation grouping (DRY — never re-derive it).
		for (const convGroup of groupHitsByConversation(projectHits)) {
			groups.push({
				projectId,
				projectName: projectHits[0].projectName,
				conversationId: convGroup.conversationId,
				conversationTitle: convGroup.title,
				rows: convGroup.hits.map((hit) => ({ kind: "hit", hit })),
			});
		}
	}
	return groups;
}

/** Append every actionable row in a section's groups to the flat list. */
function pushSectionRows(flatItems: (Command | MessageSearchHit)[], section: PaletteSection): void {
	for (const group of section.groups) {
		for (const row of group.rows) {
			flatItems.push(row.kind === "command" ? row.command : row.hit);
		}
	}
}

/**
 * Build the palette render tree + flat actionable-row list.
 *
 * With an active conversation: sections = [commands?, in-this-conversation?,
 * other?]. With none (null): sections = [commands?, messages?]. Empty sections
 * are omitted. `flatItems` lists commands first, then hits in render order
 * (in-this-conversation before other), identity-matching the rendered rows.
 */
export function buildPaletteResults(
	matchingCommands: Command[],
	hits: MessageSearchHit[],
	activeConversationId: string | null,
): PaletteResults {
	const sections: PaletteSection[] = [];

	if (matchingCommands.length > 0) {
		sections.push({
			id: "commands",
			label: "Commands",
			groups: [{ rows: matchingCommands.map((command) => ({ kind: "command", command })) }],
		});
	}

	if (activeConversationId !== null) {
		const inConv = hits.filter((h) => h.conversationId === activeConversationId);
		const other = hits.filter((h) => h.conversationId !== activeConversationId);

		if (inConv.length > 0) {
			sections.push({
				id: "in-this-conversation",
				label: "In this conversation",
				groups: groupHitsByProjectConversation(inConv),
			});
		}
		if (other.length > 0) {
			sections.push({
				id: "other",
				label: "Other",
				groups: groupHitsByProjectConversation(other),
			});
		}
	} else if (hits.length > 0) {
		sections.push({
			id: "messages",
			label: "Messages",
			groups: groupHitsByProjectConversation(hits),
		});
	}

	// Flat list built from the SAME section/group/row tree → identity-aligned
	// with render order; headers are never included.
	const flatItems: (Command | MessageSearchHit)[] = [];
	for (const section of sections) pushSectionRows(flatItems, section);

	return { sections, flatItems };
}
