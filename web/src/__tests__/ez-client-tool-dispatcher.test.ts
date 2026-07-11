/**
 * Ez client-tool dispatcher — SSR / no-DOM behaviour (bun:test).
 *
 * This suite runs under `bun test`, which has no DOM. It pins the
 * environment-safety contract: the same-origin navigate allowlist is pure
 * logic (works anywhere), and the DOM-dependent tools (`read_page` /
 * `fill_form`) fail CLOSED with a `no-dom` code rather than throwing when
 * there is no document to serialize.
 *
 * The full DOM behaviour (read_page/fill_form/navigate destination) is
 * covered under jsdom in
 * `web/src/lib/ez/__tests__/client-tool-dispatcher.unit.test.ts`, which is
 * also the coverage-bearing suite for this module.
 */
import { test, expect, describe } from "bun:test";
import {
	dispatch,
	isAllowedNavigateTarget,
	type DispatcherDeps,
} from "../lib/ez/client-tool-dispatcher";

function makeDeps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
	return {
		goto: async () => {},
		...over,
	};
}

describe("isAllowedNavigateTarget — same-origin allowlist", () => {
	test("accepts canonical app routes", () => {
		expect(isAllowedNavigateTarget("/marketplace")).toBe(true);
		expect(isAllowedNavigateTarget("/marketplace?q=pdf")).toBe(true);
		expect(isAllowedNavigateTarget("/agents/new")).toBe(true);
		expect(isAllowedNavigateTarget("/project/abc/chat/xyz")).toBe(true);
		expect(isAllowedNavigateTarget("/settings")).toBe(true);
		expect(isAllowedNavigateTarget("/docs/api")).toBe(true);
	});

	test("rejects external URLs", () => {
		expect(isAllowedNavigateTarget("https://example.com/")).toBe(false);
		expect(isAllowedNavigateTarget("//evil.test")).toBe(false);
		expect(isAllowedNavigateTarget("javascript:alert(1)")).toBe(false);
		expect(isAllowedNavigateTarget("file:///etc/passwd")).toBe(false);
	});

	test("rejects unrecognised in-app prefixes", () => {
		expect(isAllowedNavigateTarget("/random-stuff")).toBe(false);
		expect(isAllowedNavigateTarget("/login")).toBe(false);
		expect(isAllowedNavigateTarget("")).toBe(false);
	});

	test("rejects strings with control characters", () => {
		expect(isAllowedNavigateTarget("/agents\nFoo")).toBe(false);
	});
});

describe("dispatch — DOM-dependent tools fail closed without a document", () => {
	test("read_page returns 'no-dom' when no DOM root is available", async () => {
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "read_page", input: {} },
			makeDeps(),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("no-dom");
			expect(r.error.toLowerCase()).toContain("dom");
		}
	});

	test("fill_form returns 'no-dom' when no DOM root is available", async () => {
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "fill_form", input: { formId: "f", values: {} } },
			makeDeps(),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("no-dom");
	});
});

describe("dispatch — navigate_to routing", () => {
	test("allows same-origin in-app paths, calls goto, returns the path", async () => {
		const calls: string[] = [];
		const deps = makeDeps({ goto: async (p: string) => { calls.push(p); } });
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/marketplace?q=pdf" } },
			deps,
		);
		expect(r.ok).toBe(true);
		expect(calls).toEqual(["/marketplace?q=pdf"]);
		// No DOM under bun → best-effort destination serialization yields
		// nothing; the result still carries the requested path.
		if (r.ok) expect(r.detail).toEqual({ path: "/marketplace?q=pdf" });
	});

	test("rejects external URLs without calling goto", async () => {
		let called = false;
		const deps = makeDeps({ goto: async () => { called = true; } });
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "https://evil.test/" } },
			deps,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("rejected");
		expect(called).toBe(false);
	});

	test("rejects unknown in-app prefixes (e.g. /login)", async () => {
		let called = false;
		const deps = makeDeps({ goto: async () => { called = true; } });
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/login" } },
			deps,
		);
		expect(r.ok).toBe(false);
		expect(called).toBe(false);
	});

	test("captures goto exceptions and reports them as 'rejected'", async () => {
		const deps = makeDeps({ goto: async () => { throw new Error("fail"); } });
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/marketplace" } },
			deps,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("rejected");
			expect(r.error).toContain("fail");
		}
	});
});

describe("dispatch — unknown tool", () => {
	test("returns 'unknown-tool' for tool names not in the client allowlist", async () => {
		const deps = makeDeps();
		const r = await dispatch(
			{ conversationId: "c", toolCallId: "t", toolName: "summarize_conversation", input: {} },
			deps,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("unknown-tool");
	});
});
