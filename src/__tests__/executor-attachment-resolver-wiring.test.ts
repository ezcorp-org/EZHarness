/**
 * Structural guard: every `new ToolExecutor(...)` inside the
 * stream-chat tool-setup path (`stream-chat/setup-tools.ts::setupTools`)
 * must be followed by `setArgsResolver(attachmentArgsResolver)` so
 * attachment handles resolve regardless of WHICH ToolExecutor
 * (agent-config tools, conversation-extension tools, scratchpad
 * auto-wire, mode-attached extensions) dispatches the call.
 *
 * Full behavioral coverage of the resolver contract itself lives in
 * `ext-registry-executor.test.ts` (argsResolver transforms input,
 * back-compat no-op) and `attachment-handle-resolver.test.ts`. This test
 * exists purely to catch someone adding a new ToolExecutor call site in
 * setup-tools.ts and forgetting to thread the resolver through it.
 *
 * **SUT path note:** at commit `f912990 feat(host): wire PermissionEngine
 * into all ToolExecutor instantiation sites`, the tool-resolver wiring
 * moved out of `executor.ts::streamChat()` and into
 * `stream-chat/setup-tools.ts::setupTools()`. Past-attachment rehydration
 * (`loadPastAttachments` / `rehydrateUserMessageContent`) similarly moved
 * to `stream-chat/load-history.ts::loadHistory()`. This test re-points at
 * both SUTs accordingly.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETUP_TOOLS_PATH = join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts");
const LOAD_HISTORY_PATH = join(import.meta.dir, "..", "runtime", "stream-chat", "load-history.ts");
const setupToolsSource = readFileSync(SETUP_TOOLS_PATH, "utf-8");
const loadHistorySource = readFileSync(LOAD_HISTORY_PATH, "utf-8");

/** Extract the body of `export async function setupTools(...): Promise<SetupToolsResult> { ... }`
 *  by brace-matching from the opening body brace to its matching close. */
function extractSetupToolsBody(src: string): string {
	const signature = /export\s+async\s+function\s+setupTools\s*\(/;
	const start = src.search(signature);
	if (start < 0) throw new Error("setupTools declaration not found in setup-tools.ts");
	// Skip to `)` of the signature, then to `{` of the body.
	let i = start;
	let parens = 0;
	let sawOpenParen = false;
	while (i < src.length) {
		const c = src[i]!;
		if (c === "(") { parens++; sawOpenParen = true; }
		else if (c === ")") { parens--; if (sawOpenParen && parens === 0) { i++; break; } }
		i++;
	}
	while (i < src.length && src[i] !== "{") i++;
	if (src[i] !== "{") throw new Error("could not locate setupTools body");
	const bodyStart = i;
	let depth = 0;
	for (; i < src.length; i++) {
		const c = src[i]!;
		if (c === "{") depth++;
		else if (c === "}") { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
	}
	throw new Error("setupTools body is unbalanced");
}

const body = extractSetupToolsBody(setupToolsSource);

describe("setupTools attachment-resolver wiring", () => {
	test("constructs the attachment-aware args resolver at the top of the method", () => {
		expect(body).toContain("attachmentArgsResolver");
		expect(body).toContain("buildAttachmentHandleResolver");
	});

	test("every ToolExecutor instance in setupTools threads the resolver", () => {
		// Count construction sites and resolver assignments. Any mismatch
		// means a new call site was added without the `setArgsResolver` line.
		const constructions = body.match(/new\s+ToolExecutor\s*\(/g) ?? [];
		const wires = body.match(/\.setArgsResolver\s*\(\s*attachmentArgsResolver\s*\)/g) ?? [];
		expect(constructions.length).toBeGreaterThan(0);
		expect(wires.length).toBe(constructions.length);
	});

	test("resolver wiring uses the single shared variable (not a fresh build per call site)", () => {
		// One construction of attachmentArgsResolver, many uses.
		const builds = body.match(/const\s+attachmentArgsResolver\s*=/g) ?? [];
		expect(builds.length).toBe(1);
	});

	test("resolver union includes current-turn AND past-branch attachments", () => {
		// The current-turn spread comes from options.attachments; the past
		// set is `allPastAttachments` loaded via the rehydrate helper. Both
		// must feed the resolver so prior-turn handles still work.
		expect(body).toContain("options.attachments");
		expect(body).toContain("allPastAttachments");
	});

	test("past-attachment rehydration runs in load-history before history materialization", () => {
		// loadPastAttachments + rehydrateUserMessageContent now live in
		// stream-chat/load-history.ts (commit f912990 refactor). The
		// rehydrate must run on the branch messages so prior-turn
		// attachment handles still resolve when the LLM echoes them.
		expect(loadHistorySource).toContain("loadPastAttachments");
		expect(loadHistorySource).toContain("rehydrateUserMessageContent");
		// loadPastAttachments must come before the rehydrate call so the
		// `attsForMsg`/`pastCaps` maps are populated when rehydrate fires.
		const loadIdx = loadHistorySource.indexOf("loadPastAttachments");
		const rehydrateIdx = loadHistorySource.indexOf("rehydrateUserMessageContent");
		expect(loadIdx).toBeGreaterThan(-1);
		expect(rehydrateIdx).toBeGreaterThan(-1);
		expect(loadIdx).toBeLessThan(rehydrateIdx);
	});
});
