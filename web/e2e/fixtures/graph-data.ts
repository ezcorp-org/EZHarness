/**
 * Chat-DAG e2e fixtures — one seeded conversation plus the exact `ChatGraph`
 * payloads `GET /api/conversations/:id/graph` returns for it.
 *
 * The payloads here are hand-written to match what the real builders emit
 * (`src/runtime/chat-graph/build-conversation-dag.ts` and `build-turn-dag.ts`)
 * for the seeded rows — node order, edge kinds, and the omission of
 * `durationMs` all follow those modules. They are typed against the frozen
 * wire contract (type-only import, so nothing backend-side is bundled into
 * the Playwright run), which means a contract change breaks these fixtures
 * loudly instead of letting the specs drift.
 *
 * The seeded shape is deliberately the awkward one:
 *   - `u-plan` forks into TWO prompts — `u-rollback` (rewound away, so
 *     `excluded`) and `u-bench` (the live path). That is a rewind / A-B
 *     retry rendered as a real fork.
 *   - the `u-bench` turn spawns a sub-agent, so a `subagent` node exists on
 *     BOTH levels and is drillable into its own conversation's level 1.
 *   - one tool call has an observability-derived duration and one has NONE,
 *     which is the contract's "render an em dash, never 0ms" case.
 */
import type { Page } from "@playwright/test";
import { makeConversation, makeMessage, makeProject } from "./data.js";
import type { ChatGraph } from "../../../src/runtime/chat-graph/types.js";

export const PROJECT_ID = "proj-graph";
export const CONV_ID = "conv-graph";
/** A second conversation used only for the degraded-topology case. */
export const DEGRADED_CONV_ID = "conv-graph-degraded";
/** The conversation a sub-agent spawn drills into. */
export const SUBCONV_ID = "subconv-indexer";

/** Message ids — also the level-1 / level-2 node ids (contract: prompt id === messages.id). */
export const PROMPT_PLAN = "u-plan";
export const PROMPT_ROLLBACK = "u-rollback";
export const PROMPT_BENCH = "u-bench";
export const REPLY_BENCH = "a-bench";
/** Tool-call ids — also the level-2 `tool` node ids. */
export const TOOL_WITH_DURATION = "tc-read-schema";
export const TOOL_WITHOUT_DURATION = "tc-run-bench";

/** Node labels, asserted verbatim by both specs. */

/** The untruncated first prompt — what the tooltip and detail pane show. */
export const FULL_LABEL_PLAN =
	"Plan the database migration, including the rollback path and the index rebuild order";
/**
 * A label AT the builder's truncation boundary: exactly `LABEL_MAX` (60)
 * characters ending in the single-char ellipsis, which is precisely what
 * `truncateLabel` (`src/runtime/chat-graph/labels.ts`) emits.
 *
 * Deliberately long. A 168px node box renders roughly 23 characters, so a
 * label this size is the COMMON case in a real conversation and it is the one
 * that exercises the right-edge fade. Every other label in this file is short
 * enough to fit, which is exactly why a hard-clipped label went unnoticed.
 */
export const LABEL_PLAN = `${FULL_LABEL_PLAN.slice(0, 59)}…`;
export const LABEL_ROLLBACK = "Now write the rollback script";
export const LABEL_BENCH = "Actually, benchmark it first";
export const LABEL_SUBAGENT = "index-inspector";
export const LABEL_SUBAGENT_PROMPT = "Measure the index rebuild cost";
/** The sub-conversation's own first prompt — a node id shared with NO other level. */
export const SUBAGENT_PROMPT_ID = "s-measure";
export const LABEL_REPLY = "Benchmarked both plans.";
export const LABEL_THINKING = "Comparing pg_dump against logical replication";
export const LABEL_TOOL_WITH_DURATION = "read_file";
export const LABEL_TOOL_WITHOUT_DURATION = "run_shell";

export const project = makeProject({ id: PROJECT_ID, name: "Graph Project" });
export const conversation = makeConversation({
	id: CONV_ID,
	projectId: PROJECT_ID,
	title: "Migration planning",
});
export const degradedConversation = makeConversation({
	id: DEGRADED_CONV_ID,
	projectId: PROJECT_ID,
	title: "Degraded topology",
});

/**
 * The transcript behind the graph. Seeded through `mockApi` so the chat page
 * renders a real thread and the header button is exercised in situ rather
 * than against an empty chat.
 */
export const messages = [
	makeMessage({
		id: PROMPT_PLAN,
		conversationId: CONV_ID,
		role: "user",
		// The transcript carries the FULL prompt; the graph node's `label` is
		// the truncated derivative of it, which is the real relationship.
		content: FULL_LABEL_PLAN,
		parentMessageId: null,
		createdAt: "2026-04-01T00:00:00.000Z",
	}),
	makeMessage({
		id: "a-plan",
		conversationId: CONV_ID,
		role: "assistant",
		content: "Three steps: snapshot, migrate, verify.",
		parentMessageId: PROMPT_PLAN,
		createdAt: "2026-04-01T00:00:10.000Z",
	}),
	makeMessage({
		id: PROMPT_ROLLBACK,
		conversationId: CONV_ID,
		role: "user",
		content: LABEL_ROLLBACK,
		parentMessageId: "a-plan",
		createdAt: "2026-04-01T00:01:00.000Z",
	}),
	makeMessage({
		id: PROMPT_BENCH,
		conversationId: CONV_ID,
		role: "user",
		content: LABEL_BENCH,
		parentMessageId: "a-plan",
		createdAt: "2026-04-01T00:02:00.000Z",
	}),
	makeMessage({
		id: REPLY_BENCH,
		conversationId: CONV_ID,
		role: "assistant",
		content: LABEL_REPLY,
		parentMessageId: PROMPT_BENCH,
		createdAt: "2026-04-01T00:02:30.000Z",
	}),
];

/**
 * LEVEL 1 — the conversation map.
 *
 * `u-plan` has two prompt children, so BOTH outgoing edges are `branch`
 * (the builder marks every leg of a fork, not just the rewound one), and the
 * rewound-away leg carries `excluded: true` so the UI greys it.
 */
export const level1: ChatGraph = {
	level: 1,
	rootId: CONV_ID,
	conversationId: CONV_ID,
	nodes: [
		{
			id: PROMPT_PLAN,
			kind: "prompt",
			label: LABEL_PLAN,
			// Set by the builder whenever truncation changed the string, and the
			// only way back to the full text from the node box.
			fullLabel: FULL_LABEL_PLAN,
			status: "success",
			createdAt: "2026-04-01T00:00:00.000Z",
			drillable: true,
			// Turn roll-up: elapsed span plus what the turn contained. Mirrors
			// what `buildConversationDag` computes for a real turn.
			durationMs: 42_000,
			stats: {
				replies: 2,
				toolCalls: 3,
				subAgents: 1,
				thinking: 1,
				inputTokens: 12_400,
				outputTokens: 980,
			},
		},
		{
			id: PROMPT_ROLLBACK,
			kind: "prompt",
			label: LABEL_ROLLBACK,
			status: "success",
			createdAt: "2026-04-01T00:01:00.000Z",
			drillable: true,
			excluded: true,
			// A turn that produced nothing: every optional count is dropped from
			// the card, and `replies: 0` is still shown because it is news.
			stats: { replies: 0, toolCalls: 0, subAgents: 0, thinking: 0 },
		},
		{
			id: PROMPT_BENCH,
			kind: "prompt",
			label: LABEL_BENCH,
			status: "success",
			createdAt: "2026-04-01T00:02:00.000Z",
			drillable: true,
			durationMs: 8000,
			stats: { replies: 1, toolCalls: 2, subAgents: 1, thinking: 1 },
		},
		{
			id: SUBCONV_ID,
			kind: "subagent",
			label: LABEL_SUBAGENT,
			status: "success",
			createdAt: "2026-04-01T00:02:30.000Z",
			drillable: true,
			subConversationId: SUBCONV_ID,
		},
	],
	edges: [
		{ from: PROMPT_PLAN, to: PROMPT_ROLLBACK, kind: "branch" },
		{ from: PROMPT_PLAN, to: PROMPT_BENCH, kind: "branch" },
		{ from: PROMPT_BENCH, to: SUBCONV_ID, kind: "spawn" },
	],
};

/**
 * LEVEL 2 — the `u-bench` turn's internals.
 *
 * `tc-run-bench` deliberately carries NO `durationMs`: it is a built-in tool
 * whose `tool_calls.duration_ms` is the hardcoded 0 and which has no matching
 * observability row, so the builder omits the field and the UI must render an
 * em dash. `tc-read-schema` has a real obs-derived duration for contrast.
 */
export const level2Bench: ChatGraph = {
	level: 2,
	rootId: PROMPT_BENCH,
	conversationId: CONV_ID,
	nodes: [
		{
			id: PROMPT_BENCH,
			kind: "prompt",
			label: LABEL_BENCH,
			status: "success",
			createdAt: "2026-04-01T00:02:00.000Z",
			// Not drillable: on level 2 the prompt IS the root.
		},
		{
			id: `thinking:${REPLY_BENCH}`,
			kind: "thinking",
			label: LABEL_THINKING,
			status: "success",
			createdAt: "2026-04-01T00:02:30.000Z",
		},
		{
			id: TOOL_WITH_DURATION,
			kind: "tool",
			label: LABEL_TOOL_WITH_DURATION,
			status: "success",
			createdAt: "2026-04-01T00:02:05.000Z",
			extensionId: "builtin",
			durationMs: 840,
		},
		{
			id: TOOL_WITHOUT_DURATION,
			kind: "tool",
			label: LABEL_TOOL_WITHOUT_DURATION,
			status: "success",
			createdAt: "2026-04-01T00:02:15.000Z",
			extensionId: "builtin",
		},
		{
			id: REPLY_BENCH,
			kind: "assistant",
			label: LABEL_REPLY,
			status: "success",
			createdAt: "2026-04-01T00:02:30.000Z",
			durationMs: 4200,
		},
		{
			id: SUBCONV_ID,
			kind: "subagent",
			label: LABEL_SUBAGENT,
			status: "success",
			createdAt: "2026-04-01T00:02:30.000Z",
			drillable: true,
			subConversationId: SUBCONV_ID,
		},
	],
	edges: [
		{ from: PROMPT_BENCH, to: `thinking:${REPLY_BENCH}`, kind: "sequence" },
		{ from: `thinking:${REPLY_BENCH}`, to: TOOL_WITH_DURATION, kind: "sequence" },
		{ from: TOOL_WITH_DURATION, to: TOOL_WITHOUT_DURATION, kind: "sequence" },
		{ from: TOOL_WITHOUT_DURATION, to: REPLY_BENCH, kind: "sequence" },
		{ from: REPLY_BENCH, to: SUBCONV_ID, kind: "spawn" },
	],
};

/** LEVEL 1 of the spawned sub-agent's OWN conversation. */
export const level1SubAgent: ChatGraph = {
	level: 1,
	rootId: SUBCONV_ID,
	conversationId: SUBCONV_ID,
	nodes: [
		{
			id: SUBAGENT_PROMPT_ID,
			kind: "prompt",
			label: LABEL_SUBAGENT_PROMPT,
			status: "success",
			createdAt: "2026-04-01T00:02:31.000Z",
			drillable: true,
		},
	],
	edges: [],
};

/**
 * A level-1 graph built with the session-history producer OFF: branch
 * topology was unreadable, so the map degraded to a flat chain. This is a
 * NOTICE, not an error — the payload rendered fine.
 */
export const level1Degraded: ChatGraph = {
	level: 1,
	rootId: DEGRADED_CONV_ID,
	conversationId: DEGRADED_CONV_ID,
	nodes: [
		{
			id: "d-first",
			kind: "prompt",
			label: "Set up the staging box",
			status: "success",
			createdAt: "2026-04-01T00:00:00.000Z",
			drillable: true,
		},
		{
			id: "d-second",
			kind: "prompt",
			label: "Now point the CDN at it",
			status: "success",
			createdAt: "2026-04-01T00:01:00.000Z",
			drillable: true,
		},
	],
	edges: [{ from: "d-first", to: "d-second", kind: "sequence" }],
	degraded: true,
};

/** Key into the graph table: level 1 is the bare conversation id. */
export function graphKey(conversationId: string, turn: string | null): string {
	return turn === null ? conversationId : `${conversationId}?turn=${turn}`;
}

/** The default table — every graph the seeded conversation can reach. */
export const graphs: Record<string, ChatGraph> = {
	[graphKey(CONV_ID, null)]: level1,
	[graphKey(CONV_ID, PROMPT_BENCH)]: level2Bench,
	[graphKey(SUBCONV_ID, null)]: level1SubAgent,
	[graphKey(DEGRADED_CONV_ID, null)]: level1Degraded,
};

/**
 * Serve `GET /api/conversations/:id/graph[?turn=…]` from `table`, 404-ing
 * anything not in it (which is exactly what the real owner-gated route does
 * for an unknown turn).
 *
 * MUST be called AFTER `mockApi()` — Playwright matches routes in reverse
 * registration order, so this has to be the newer handler to win over the
 * catch-all `**\/api\/**` in `api-mocks.ts`.
 *
 * Returns the live list of requested URLs so a spec can prove which level
 * was fetched (`?turn=…`) rather than only that the view changed.
 */
export async function mockGraphApi(
	page: Page,
	table: Record<string, ChatGraph> = graphs,
): Promise<string[]> {
	const requested: string[] = [];
	await page.route(
		(url) => /^\/api\/conversations\/[^/]+\/graph$/.test(url.pathname),
		(route) => {
			const url = new URL(route.request().url());
			requested.push(url.pathname + url.search);
			const graph = table[graphKey(url.pathname.split("/")[3]!, url.searchParams.get("turn"))];
			if (graph === undefined) {
				return route.fulfill({ status: 404, json: { error: "Not found" } });
			}
			return route.fulfill({ json: graph });
		},
	);
	return requested;
}
