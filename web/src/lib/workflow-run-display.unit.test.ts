/**
 * Coverage-measured contract suite for `workflow-run-display.ts`.
 *
 * The sibling `src/__tests__/workflow-run-display.test.ts` runs in the web
 * BUN leg, which the coverage pipeline does not instrument — only the
 * node-vitest leg emits lcov for `web/src/lib/**`. Nothing in the
 * coverage-measured pool imports this module, so it had NO lcov data at
 * all and the gate could not see it.
 *
 * Rather than restate the sibling's case-by-case assertions, this suite
 * asserts the INVARIANTS a consumer relies on — the properties that have
 * to hold across the whole input domain, which is where both historical
 * bugs actually lived (a `tool` step rendering a blank badge; an
 * `awaiting_approval` run rendering no explanation).
 */

import { test, expect, describe } from "vitest";
import {
	isExplainableStatus,
	kindLabel,
	runErrorText,
	statusColor,
} from "./workflow-run-display.js";

/** Every step kind the server's `WorkflowStepKind` union can emit. */
const STEP_KINDS = ["agent", "transform", "gate", "tool"] as const;

/** Every run/step status the page can be handed. */
const STATUSES = [
	"idle",
	"running",
	"success",
	"error",
	"cancelled",
	"awaiting_approval",
] as const;

describe("kindLabel — never renders an empty badge", () => {
	test.each(STEP_KINDS)("%s has a non-empty label", (kind) => {
		expect(kindLabel(kind)).toBe(kind);
	});

	test("an unmapped kind falls back to the raw value, not an empty string", () => {
		// The regression: a `Record` lookup with no fallback rendered a
		// blank chip for every kind added server-side after this map.
		for (const unknown of ["future-kind", "TOOL", " tool", ""]) {
			expect(kindLabel(unknown)).toBe(unknown);
		}
	});

	test("no input can produce a nullish label", () => {
		for (const k of [...STEP_KINDS, "anything", ""]) {
			expect(typeof kindLabel(k)).toBe("string");
		}
	});
});

describe("statusColor — every status is visually resolvable", () => {
	test.each(STATUSES)("%s maps to a non-empty tailwind class", (status) => {
		const c = statusColor(status);
		expect(c.length).toBeGreaterThan(0);
		expect(c.startsWith("text-")).toBe(true);
	});

	test("the four terminal-ish states are pairwise DISTINCT", () => {
		// awaiting_approval is blocked-on-a-human: it must not be
		// mistakable for success, failure, cancellation, or in-progress.
		const colors = [
			statusColor("success"),
			statusColor("error"),
			statusColor("cancelled"),
			statusColor("awaiting_approval"),
			statusColor("running"),
		];
		expect(new Set(colors).size).toBe(colors.length);
	});

	test("an unknown status reads as in-progress, never blank", () => {
		expect(statusColor("some-future-status")).toBe(statusColor("running"));
	});
});

describe("isExplainableStatus / runErrorText — the cross-function invariant", () => {
	test("a status with nothing to explain yields no text, whatever the payload", () => {
		// The invariant the page depends on: if the status is not
		// explainable, runErrorText is empty even when the run carries a
		// perfectly good error object.
		const loudPayload = { error: { code: "X", message: "should not render" } };
		for (const status of STATUSES.filter((s) => !isExplainableStatus(s))) {
			expect(runErrorText({ status, result: loudPayload } as never)).toBe("");
		}
	});

	test("every explainable status DOES surface its message", () => {
		for (const status of STATUSES.filter(isExplainableStatus)) {
			expect(runErrorText({ status, result: { error: "boom" } } as never)).toBe("boom");
		}
	});

	test("success/running/idle are the only non-explainable statuses", () => {
		expect(STATUSES.filter((s) => !isExplainableStatus(s)).sort()).toEqual([
			"idle",
			"running",
			"success",
		]);
	});
});

describe("runErrorText — tolerates every payload shape the backend emits", () => {
	const explainable = { status: "error" } as const;

	test("plain string error (gate / loop failures)", () => {
		expect(runErrorText({ ...explainable, result: { error: "Gate \"x\" failed" } } as never)).toBe(
			'Gate "x" failed',
		);
	});

	test("{ code, message } object error (cancellation, awaiting approval)", () => {
		expect(
			runErrorText({ ...explainable, result: { error: { code: "CANCELLED", message: "by user" } } } as never),
		).toBe("by user");
	});

	test("a non-string message is stringified rather than leaked as an object", () => {
		expect(
			runErrorText({ ...explainable, result: { error: { message: 42 } } } as never),
		).toBe("42");
	});

	test("always returns a string — missing result, missing error, odd shapes", () => {
		const cases: unknown[] = [
			{ status: "error" },
			{ status: "error", result: {} },
			{ status: "error", result: { error: null } },
			{ status: "error", result: { error: undefined } },
			{ status: "error", result: { error: 7 } },
			{ status: "error", result: { error: {} } },
			{ status: "error", result: { error: [] } },
		];
		for (const c of cases) {
			const out = runErrorText(c as never);
			expect(typeof out).toBe("string");
		}
		// The specific ones that must be EMPTY (nothing usable to show).
		expect(runErrorText({ status: "error" } as never)).toBe("");
		expect(runErrorText({ status: "error", result: { error: 7 } } as never)).toBe("");
	});
});
