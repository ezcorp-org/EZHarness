/**
 * Unit tests for createSaveFlash — the shared auto-save feedback state
 * (locked decision 5).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createSaveFlash } from "./save-flash.svelte";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createSaveFlash", () => {
	test("saving during the run, saved after, cleared after timeout", async () => {
		const flash = createSaveFlash(2000);
		let release!: () => void;
		const pending = new Promise<void>((r) => {
			release = r;
		});

		const run = flash.run(() => pending);
		expect(flash.saving).toBe(true);
		expect(flash.saved).toBe(false);

		release();
		await run;
		expect(flash.saving).toBe(false);
		expect(flash.saved).toBe(true);

		vi.advanceTimersByTime(2000);
		expect(flash.saved).toBe(false);
	});

	test("failure clears saving, never sets saved, and rethrows", async () => {
		const flash = createSaveFlash();
		await expect(flash.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(flash.saving).toBe(false);
		expect(flash.saved).toBe(false);
	});

	test("back-to-back runs reset the clear timer", async () => {
		const flash = createSaveFlash(2000);
		await flash.run(() => Promise.resolve());
		vi.advanceTimersByTime(1500);
		await flash.run(() => Promise.resolve());
		vi.advanceTimersByTime(1500);
		// 3s after the first run but only 1.5s after the second — still shown.
		expect(flash.saved).toBe(true);
		vi.advanceTimersByTime(500);
		expect(flash.saved).toBe(false);
	});
});
