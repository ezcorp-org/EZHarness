/**
 * E2E for the memories injection-eligibility toggle (v1.4).
 *
 * Sibling layout — matches the codebase pattern (memory-injection.spec.ts
 * is its own file, distinct from memories.spec.ts which focuses on
 * list/edit/delete CRUD). The eligibility toggle is a privacy-relevant
 * control surface that previously had only Vitest-component coverage
 * (MemoryItem.eligibility.component.test.ts); this spec exercises the
 * full browser round-trip — render → click → PATCH → optimistic flip →
 * server confirm → revert-on-error → toast.
 *
 * Coverage targets (per plan §1.1):
 *   1. Initial render — `injectionEligible: true`  → "Allowed" text + emerald cue
 *   2. Initial render — `injectionEligible: false` → "Excluded" text + amber cue
 *   3. Click → PATCH request body shape + optimistic UI flip
 *   4. PATCH 500 → row reverts AND error toast surfaces
 *   5. aria-label flips with state (a11y regression guard)
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMemory } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Eligibility Project" });

test.describe("Memories — injection-eligibility toggle", () => {
	test("initial render with `injectionEligible: true` → Allowed status + emerald state", async ({
		page,
		mockApi,
	}) => {
		const mem = makeMemory({
			id: "mem-allowed",
			content: "User prefers TypeScript",
			injectionEligible: true,
		} as any);
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		// Expand the row to reveal the toggle (the toggle lives in the
		// expanded body — the collapsed card only shows the preview).
		await page.getByText("User prefers TypeScript").click();

		const toggle = page.getByTestId("injection-eligibility-toggle");
		await expect(toggle).toBeVisible({ timeout: 5000 });
		await expect(toggle).toHaveAttribute("data-state", "allowed");
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(toggle).toHaveAttribute(
			"aria-label",
			"Memory allowed in chat context. Click to exclude.",
		);

		await expect(page.getByTestId("injection-eligibility-status")).toHaveText(
			"Allowed in chat context",
		);

		// Outer row carries the data attribute for visual cue + a11y.
		const row = page.getByTestId("memory-row");
		await expect(row).toHaveAttribute("data-injection-eligible", "true");
	});

	test("initial render with `injectionEligible: false` → Excluded status + amber state", async ({
		page,
		mockApi,
	}) => {
		const mem = makeMemory({
			id: "mem-excluded",
			content: "Hidden memory content",
			injectionEligible: false,
		} as any);
		await mockApi({ projects: [proj], memories: [mem] });
		await page.goto("/memories");

		await page.getByText("Hidden memory content").click();

		const toggle = page.getByTestId("injection-eligibility-toggle");
		await expect(toggle).toBeVisible({ timeout: 5000 });
		await expect(toggle).toHaveAttribute("data-state", "excluded");
		// `aria-pressed` is the inverse of `injectionEligible` — when the
		// memory is excluded the toggle reads as "pressed".
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(toggle).toHaveAttribute(
			"aria-label",
			"This memory is excluded from chat context. Click to allow.",
		);
		await expect(page.getByTestId("injection-eligibility-status")).toHaveText(
			"Excluded from chat context",
		);
		await expect(page.getByTestId("memory-row")).toHaveAttribute(
			"data-injection-eligible",
			"false",
		);
	});

	test("click → PATCH `{injectionEligible: false}` + UI flips to Excluded", async ({
		page,
		mockApi,
	}) => {
		const mem = makeMemory({
			id: "mem-flip",
			content: "Flip me memory",
			injectionEligible: true,
		} as any);
		await mockApi({ projects: [proj], memories: [mem] });

		// Capture the PATCH request body. Register AFTER mockApi so this
		// handler shadows the default `/api/memories/:id PUT` mock and
		// catches the PATCH method specifically.
		const patchCalls: Array<{ body: any }> = [];
		await page.route("**/api/memories/mem-flip", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			const body = route.request().postDataJSON();
			patchCalls.push({ body });
			// Server returns the updated row (full shape, including projectIds
			// — mirrors the real endpoint's response shape so `onupdated`
			// propagates correctly).
			await route.fulfill({
				json: {
					...mem,
					injectionEligible: body.injectionEligible,
					projectIds: ["proj-1"],
				},
			});
		});

		await page.goto("/memories");
		await page.getByText("Flip me memory").click();

		const toggle = page.getByTestId("injection-eligibility-toggle");
		await expect(toggle).toHaveAttribute("data-state", "allowed", { timeout: 5000 });

		await toggle.click();

		// Optimistic flip — UI updates before the server response settles.
		await expect(toggle).toHaveAttribute("data-state", "excluded", { timeout: 3000 });
		await expect(page.getByTestId("injection-eligibility-status")).toHaveText(
			"Excluded from chat context",
		);
		await expect(page.getByTestId("memory-row")).toHaveAttribute(
			"data-injection-eligible",
			"false",
		);

		// PATCH fired exactly once with the right body shape.
		expect(patchCalls).toHaveLength(1);
		expect(patchCalls[0]!.body).toEqual({ injectionEligible: false });
	});

	test("PATCH 500 → optimistic flip reverts AND error toast surfaces", async ({
		page,
		mockApi,
	}) => {
		const mem = makeMemory({
			id: "mem-fail",
			content: "Revert me memory",
			injectionEligible: true,
		} as any);
		await mockApi({ projects: [proj], memories: [mem] });

		await page.route("**/api/memories/mem-fail", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			await route.fulfill({
				status: 500,
				json: { error: "Database write failed" },
			});
		});

		await page.goto("/memories");
		await page.getByText("Revert me memory").click();

		const toggle = page.getByTestId("injection-eligibility-toggle");
		await expect(toggle).toHaveAttribute("data-state", "allowed", { timeout: 5000 });

		await toggle.click();

		// The optimistic flip happens momentarily then reverts when the 500
		// lands. By the time we re-assert, the catch block has restored
		// `injectionEligible = previousValue`.
		await expect(toggle).toHaveAttribute("data-state", "allowed", { timeout: 5000 });
		await expect(page.getByTestId("injection-eligibility-status")).toHaveText(
			"Allowed in chat context",
		);

		// Error toast surfaces the server's `data.error` verbatim. The
		// component's catch block calls `addToast({type: "error", message})`
		// so the bubble is `Database write failed`.
		await expect(page.getByText("Database write failed")).toBeVisible({
			timeout: 3000,
		});
	});

	test("aria-label updates when toggle state flips (a11y regression guard)", async ({
		page,
		mockApi,
	}) => {
		const mem = makeMemory({
			id: "mem-a11y",
			content: "A11y memory content",
			injectionEligible: true,
		} as any);
		await mockApi({ projects: [proj], memories: [mem] });

		await page.route("**/api/memories/mem-a11y", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			const body = route.request().postDataJSON();
			await route.fulfill({
				json: { ...mem, injectionEligible: body.injectionEligible, projectIds: [] },
			});
		});

		await page.goto("/memories");
		await page.getByText("A11y memory content").click();

		const toggle = page.getByTestId("injection-eligibility-toggle");
		// Initial label
		await expect(toggle).toHaveAttribute(
			"aria-label",
			"Memory allowed in chat context. Click to exclude.",
		);

		await toggle.click();

		// Label flips. This is the a11y contract — screen-reader users
		// must hear the NEW state and the NEXT action, not the previous.
		await expect(toggle).toHaveAttribute(
			"aria-label",
			"This memory is excluded from chat context. Click to allow.",
			{ timeout: 5000 },
		);
	});
});
