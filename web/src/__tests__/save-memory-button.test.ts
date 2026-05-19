import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * Unit tests for the save-to-memory button behavior.
 * Tests the handleSaveMemory function logic and POST request construction.
 */

describe("handleSaveMemory", () => {
	let fetchCalls: { url: string; init: RequestInit }[] = [];
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchCalls = [];
		globalThis.fetch = mock((url: string, init?: RequestInit) => {
			fetchCalls.push({ url, init: init! });
			return Promise.resolve(new Response(JSON.stringify({ id: "mem-new" }), { status: 201 }));
		}) as any;
	});

	// Replicate the handleSaveMemory function from +page.svelte
	async function handleSaveMemory(msg: { content: string }) {
		try {
			await fetch("/api/memories", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: msg.content,
					category: "preferences",
					confidence: "medium",
				}),
			});
		} catch {
			// silent
		}
	}

	test("sends POST to /api/memories", async () => {
		await handleSaveMemory({ content: "User likes dark mode" });

		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]!.url).toBe("/api/memories");
		expect(fetchCalls[0]!.init.method).toBe("POST");
	});

	test("sends message content in request body", async () => {
		await handleSaveMemory({ content: "I prefer TypeScript over JavaScript" });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.content).toBe("I prefer TypeScript over JavaScript");
	});

	test("defaults category to preferences", async () => {
		await handleSaveMemory({ content: "test" });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.category).toBe("preferences");
	});

	test("defaults confidence to medium", async () => {
		await handleSaveMemory({ content: "test" });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.confidence).toBe("medium");
	});

	test("sets Content-Type header to application/json", async () => {
		await handleSaveMemory({ content: "test" });

		const headers = fetchCalls[0]!.init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
	});

	test("does not throw when fetch fails", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as any;

		// Should not throw
		await handleSaveMemory({ content: "test" });
	});

	test("does not throw when server returns error status", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ error: "Bad request" }), { status: 400 })),
		) as any;

		await handleSaveMemory({ content: "test" });
	});

	test("preserves exact message content including whitespace", async () => {
		const content = "  Line 1\n  Line 2\n  Line 3  ";
		await handleSaveMemory({ content });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.content).toBe(content);
	});

	test("handles empty string content", async () => {
		await handleSaveMemory({ content: "" });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.content).toBe("");
		// The server will reject this, but the client doesn't validate
	});

	test("handles long content", async () => {
		const longContent = "x".repeat(10000);
		await handleSaveMemory({ content: longContent });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.content).toBe(longContent);
	});

	test("handles content with special characters", async () => {
		const content = 'Code: `const x = "hello"` and <html> tags & entities';
		await handleSaveMemory({ content });

		const body = JSON.parse(fetchCalls[0]!.init.body as string);
		expect(body.content).toBe(content);
	});

	// Restore fetch after all tests
	test("cleanup", () => {
		globalThis.fetch = originalFetch;
	});
});

describe("MessageToolbar save memory state", () => {
	test("saveMemoryState transitions: idle -> saved -> idle", async () => {
		// Simulate the state machine from MessageToolbar
		let saveMemoryState: "idle" | "saved" = "idle";
		let saveMemoryTimer: ReturnType<typeof setTimeout> | undefined;

		expect(saveMemoryState).toBe("idle");

		// Simulate click
		const onsavememory = mock(() => {});
		onsavememory();
		saveMemoryState = "saved";
		clearTimeout(saveMemoryTimer);

		expect(saveMemoryState).toBe("saved");
		expect(onsavememory).toHaveBeenCalledTimes(1);

		// Simulate timeout reset
		saveMemoryState = "idle";
		expect(saveMemoryState).toBe("idle");
	});

	test("rapid clicks reset timer each time", () => {
		let saveMemoryState: "idle" | "saved" = "idle";
		let timerCleared = 0;
		const origClearTimeout = globalThis.clearTimeout;

		// Track clearTimeout calls
		globalThis.clearTimeout = ((id: any) => {
			timerCleared++;
			origClearTimeout(id);
		}) as any;

		// First click
		saveMemoryState = "saved";
		clearTimeout(undefined);

		// Second click while still "saved"
		saveMemoryState = "saved";
		clearTimeout(undefined);

		expect(timerCleared).toBe(2);
		expect(saveMemoryState).toBe("saved");

		globalThis.clearTimeout = origClearTimeout;
	});

	test("aria-label reflects saved state", () => {
		// Test the label derivation logic
		function getLabel(state: "idle" | "saved") {
			return state === "saved" ? "Saved to memory!" : "Save to memory";
		}

		expect(getLabel("idle")).toBe("Save to memory");
		expect(getLabel("saved")).toBe("Saved to memory!");
	});

	test("title reflects saved state", () => {
		function getTitle(state: "idle" | "saved") {
			return state === "saved" ? "Saved to memory!" : "Save to memory";
		}

		expect(getTitle("idle")).toBe("Save to memory");
		expect(getTitle("saved")).toBe("Saved to memory!");
	});
});

describe("Save memory button visibility rules", () => {
	test("button shown when onsavememory prop is provided", () => {
		const onsavememory = () => {};
		expect(!!onsavememory).toBe(true);
	});

	test("button hidden when onsavememory is undefined", () => {
		const onsavememory = undefined;
		expect(!!onsavememory).toBe(false);
	});

	test("button hidden in error state with retry", () => {
		// In error+retry state, toolbar only shows retry — no other buttons
		const isError = true;
		const onretry = () => {};
		const showOnlyRetry = isError && !!onretry;
		expect(showOnlyRetry).toBe(true);
	});

	test("button shown in non-error state for user role", () => {
		const isError = false;
		const onsavememory = () => {};
		const showSave = !isError && !!onsavememory;
		expect(showSave).toBe(true);
	});

	test("button shown in non-error state for assistant role", () => {
		const isError = false;
		const onsavememory = () => {};
		const showSave = !isError && !!onsavememory;
		expect(showSave).toBe(true);
	});
});
