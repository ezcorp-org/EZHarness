/**
 * Static source-level guardrail: any background fetch to a chat-scoped
 * endpoint (`/api/conversations/:id/...`) MUST be routed through
 * `backgroundFetch` or explicitly marked as user-initiated via
 * `userFetch`. Adding a raw `fetch(\`/api/conversations/...\`)` in chat
 * code would silently re-introduce the spam the fetch-policy module
 * was designed to eliminate.
 *
 * This test scans the source files under the chat page and its panels
 * and fails if it finds a raw `fetch(` call-site whose URL targets
 * `/api/conversations`. It is intentionally narrow — it doesn't police
 * every fetch in the codebase, only the files that host the reactive
 * effects and poll intervals that caused the original spam.
 *
 * Why unit-test the source instead of relying on the e2e budget test:
 *   - e2e only fires under flap conditions; a regression could ship
 *     that only spams under user-navigation or a specific combination
 *     of effects.
 *   - unit is fast + deterministic + runs in every PR.
 *   - if a new file in the chat area starts fetching
 *     `/api/conversations/...`, it MUST either use the policy or be
 *     added to the allow-list below with a rationale.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

// Files that host chat-page reactive effects, poll intervals, and
// handlers. Any background fetch in these files is a risk surface.
const POLICED_FILES = [
	"web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte",
	"web/src/lib/components/TeamChatPanel.svelte",
	"web/src/lib/components/AgentDetailPanel.svelte",
];

// Sites where a raw `fetch(...)` targeting /api/conversations is
// acceptable *only because* the call is a user-initiated mutation
// (POST/DELETE from a click handler) — those route through `userFetch`
// (effectively a passthrough). Nothing should be allow-listed here
// without an explanation. Empty means the policy is fully enforced.
const ALLOWED_RAW_FETCH_CONVERSATIONS: Array<{ file: string; substring: string; reason: string }> = [];

function readPoliced(file: string): string {
	return readFileSync(resolve(repoRoot, file), "utf8");
}

describe("fetch-policy source guardrail", () => {
	test("policed files import backgroundFetch from the policy module", () => {
		for (const f of POLICED_FILES) {
			const src = readPoliced(f);
			expect(src, `${f} does not import from $lib/utils/fetch-policy — raw fetches will escape the policy`)
				.toMatch(/from ['"]\$lib\/utils\/fetch-policy/);
		}
	});

	test("no raw fetch() to /api/conversations/:id* in policed files", () => {
		const offenders: Array<{ file: string; line: number; text: string }> = [];

		for (const f of POLICED_FILES) {
			const src = readPoliced(f);
			const lines = src.split("\n");
			lines.forEach((line, i) => {
				// Flag any bare `fetch(` (not `userFetch(`, not `backgroundFetch(`)
				// whose argument references `/api/conversations`. Template
				// literals with `${convId}` / `${conversationId}` /
				// `${agent.subConversationId}` all count.
				const match = /\bfetch\s*\(\s*[`'"].*\/api\/conversations/i.exec(line);
				if (!match) return;
				// Ignore userFetch / backgroundFetch — the regex above matches
				// only the bare `fetch(` token because `\b` won't let `userFetch`
				// or `backgroundFetch` trigger on `fetch(`.
				// Double-check: make sure the character before `fetch` is not a
				// letter (word boundary), to cover edge cases with identifier
				// suffixes we didn't think of.
				const before = line.slice(0, match.index);
				if (/[A-Za-z_$]$/.test(before)) return;

				const allow = ALLOWED_RAW_FETCH_CONVERSATIONS.find(
					a => a.file === f && line.includes(a.substring),
				);
				if (allow) return;

				offenders.push({ file: f, line: i + 1, text: line.trim() });
			});
		}

		if (offenders.length > 0) {
			const msg = offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
			throw new Error(
				"Raw fetch() call-sites targeting /api/conversations found in policed files.\n" +
				"These MUST go through backgroundFetch (refreshes) or userFetch (user clicks).\n" +
				"See web/src/lib/utils/fetch-policy.ts for the contract.\n\n" + msg,
			);
		}
	});

	test("policed files use backgroundFetch for at least one conversation endpoint", () => {
		// Positive assertion — if someone removes all backgroundFetch calls
		// (e.g. "simplifying" the code), catch it here. Ensures the wiring
		// isn't silently deleted.
		for (const f of POLICED_FILES) {
			const src = readPoliced(f);
			expect(src, `${f} no longer calls backgroundFetch — policy is not being applied`)
				.toMatch(/backgroundFetch\s*\(/);
		}
	});
});
