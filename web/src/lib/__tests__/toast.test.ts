import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Tests for the toast notification store logic.
 *
 * Following the streaming-store.test.ts pattern: replicate store logic as
 * plain functions to avoid Svelte rune imports. These tests define the
 * behavioral contract that the toast module must satisfy.
 */

interface ToastData {
	id: string;
	type: "success" | "error" | "warning" | "info";
	message: string;
	action?: { label: string; onclick: () => void };
	dismissAt: number;
}

// --- Replicated logic ---

let idCounter = 0;

function addToast(
	toasts: ToastData[],
	toast: Omit<ToastData, "id" | "dismissAt"> & { duration?: number },
	duration = 5000,
): ToastData[] {
	const id = `toast-${++idCounter}`;
	const dismissAt = Date.now() + (toast.duration ?? duration);
	const newToast: ToastData = {
		id,
		type: toast.type,
		message: toast.message,
		action: toast.action,
		dismissAt,
	};
	const updated = [...toasts, newToast];
	// Max 3 visible: if more than 3, remove oldest (front of array)
	if (updated.length > 3) {
		return updated.slice(updated.length - 3);
	}
	return updated;
}

function removeToast(toasts: ToastData[], id: string): ToastData[] {
	return toasts.filter((t) => t.id !== id);
}

function pauseDismiss(toast: ToastData): number {
	return toast.dismissAt - Date.now();
}

// --- Tests ---

describe("toast store", () => {
	beforeEach(() => {
		idCounter = 0;
	});

	test("add() creates toast with generated id and dismissAt", () => {
		const toasts = addToast([], {
			type: "success",
			message: "Saved!",
		});

		expect(toasts).toHaveLength(1);
		expect(toasts[0].id).toBe("toast-1");
		expect(toasts[0].type).toBe("success");
		expect(toasts[0].message).toBe("Saved!");
		expect(typeof toasts[0].dismissAt).toBe("number");
		expect(toasts[0].dismissAt).toBeGreaterThan(Date.now() - 100);
	});

	test("add() caps at 3 visible toasts", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "One" });
		toasts = addToast(toasts, { type: "info", message: "Two" });
		toasts = addToast(toasts, { type: "info", message: "Three" });
		toasts = addToast(toasts, { type: "info", message: "Four" });

		expect(toasts).toHaveLength(3);
		// Oldest (One) should be removed, newest 3 remain
		expect(toasts[0].message).toBe("Two");
		expect(toasts[1].message).toBe("Three");
		expect(toasts[2].message).toBe("Four");
	});

	test("remove() filters toast by id", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "success", message: "First" });
		toasts = addToast(toasts, { type: "error", message: "Second" });

		const idToRemove = toasts[0].id;
		toasts = removeToast(toasts, idToRemove);

		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("Second");
	});

	test("add() sets dismissAt to now + duration", () => {
		const before = Date.now();
		const toasts = addToast([], { type: "info", message: "Test" });
		const after = Date.now();

		// Default duration is 5000ms
		expect(toasts[0].dismissAt).toBeGreaterThanOrEqual(before + 5000);
		expect(toasts[0].dismissAt).toBeLessThanOrEqual(after + 5000);
	});

	test("add() with custom duration", () => {
		const before = Date.now();
		const toasts = addToast(
			[],
			{ type: "warning", message: "Quick!", duration: 3000 },
		);
		const after = Date.now();

		expect(toasts[0].dismissAt).toBeGreaterThanOrEqual(before + 3000);
		expect(toasts[0].dismissAt).toBeLessThanOrEqual(after + 3000);
	});

	test("pauseDismiss computes remaining time", () => {
		const now = Date.now();
		const toast: ToastData = {
			id: "test-1",
			type: "info",
			message: "Paused",
			dismissAt: now + 2000,
		};

		const remaining = pauseDismiss(toast);
		// Should be approximately 2000ms (within 100ms tolerance)
		expect(remaining).toBeGreaterThan(1900);
		expect(remaining).toBeLessThanOrEqual(2000);
	});

	test("add() preserves action callback", () => {
		let clicked = false;
		const toasts = addToast([], {
			type: "error",
			message: "Failed",
			action: { label: "Retry", onclick: () => { clicked = true; } },
		});

		expect(toasts[0].action).toBeDefined();
		expect(toasts[0].action!.label).toBe("Retry");
		toasts[0].action!.onclick();
		expect(clicked).toBe(true);
	});

	test("remove() with non-existent id returns same array content", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "Keep" });

		const result = removeToast(toasts, "non-existent");
		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("Keep");
	});

	test("adding to full queue (3 toasts) removes the correct oldest", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "A" });
		toasts = addToast(toasts, { type: "info", message: "B" });
		toasts = addToast(toasts, { type: "info", message: "C" });
		expect(toasts).toHaveLength(3);

		// Add a 4th — "A" should be evicted
		toasts = addToast(toasts, { type: "info", message: "D" });
		expect(toasts).toHaveLength(3);
		expect(toasts.map((t) => t.message)).toEqual(["B", "C", "D"]);

		// Add a 5th — "B" should be evicted
		toasts = addToast(toasts, { type: "info", message: "E" });
		expect(toasts).toHaveLength(3);
		expect(toasts.map((t) => t.message)).toEqual(["C", "D", "E"]);
	});

	test("multiple rapid adds and removes", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "X" });
		toasts = addToast(toasts, { type: "error", message: "Y" });
		const yId = toasts[1].id;
		toasts = removeToast(toasts, yId);
		toasts = addToast(toasts, { type: "success", message: "Z" });
		toasts = addToast(toasts, { type: "warning", message: "W" });

		expect(toasts).toHaveLength(3);
		expect(toasts.map((t) => t.message)).toEqual(["X", "Z", "W"]);
	});

	test("rapid add then remove all leaves empty", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "A" });
		toasts = addToast(toasts, { type: "info", message: "B" });
		const ids = toasts.map((t) => t.id);
		for (const id of ids) {
			toasts = removeToast(toasts, id);
		}
		expect(toasts).toHaveLength(0);
	});

	test("custom duration of 0 sets dismissAt to approximately now", () => {
		const before = Date.now();
		const toasts = addToast([], { type: "info", message: "Instant", duration: 0 });
		const after = Date.now();

		expect(toasts[0].dismissAt).toBeGreaterThanOrEqual(before);
		expect(toasts[0].dismissAt).toBeLessThanOrEqual(after);
	});

	test("all 4 toast types are correctly stored", () => {
		const types: Array<ToastData["type"]> = ["success", "error", "warning", "info"];
		let toasts: ToastData[] = [];

		// Adding 4 exceeds max 3, so we verify the type on each individually
		for (const type of types) {
			const result = addToast([], { type, message: `msg-${type}` });
			expect(result[0].type).toBe(type);
		}

		// Also verify with sequential adds (last 3 should remain)
		toasts = [];
		for (const type of types) {
			toasts = addToast(toasts, { type, message: `msg-${type}` });
		}
		expect(toasts).toHaveLength(3);
		expect(toasts[0].type).toBe("error");
		expect(toasts[1].type).toBe("warning");
		expect(toasts[2].type).toBe("info");
	});

	test("pauseDismiss returns negative when toast already past due", () => {
		const toast: ToastData = {
			id: "expired",
			type: "info",
			message: "Old",
			dismissAt: Date.now() - 1000,
		};
		const remaining = pauseDismiss(toast);
		expect(remaining).toBeLessThan(0);
	});

	test("remove() on empty array returns empty array", () => {
		const result = removeToast([], "anything");
		expect(result).toEqual([]);
	});

	test("each toast gets a unique id", () => {
		let toasts: ToastData[] = [];
		toasts = addToast(toasts, { type: "info", message: "A" });
		toasts = addToast(toasts, { type: "info", message: "B" });
		toasts = addToast(toasts, { type: "info", message: "C" });

		const ids = toasts.map((t) => t.id);
		expect(new Set(ids).size).toBe(3);
	});
});
