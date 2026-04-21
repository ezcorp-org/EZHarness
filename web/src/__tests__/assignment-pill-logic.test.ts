import { describe, test, expect } from "bun:test";

/**
 * Logic tests for AssignmentPill.svelte.
 *
 * Svelte 5 runes can't run under bun:test, so we mirror the component's
 * pure derivation logic as plain functions and exercise them directly.
 *
 * Mirrors the derivations in web/src/lib/components/AssignmentPill.svelte.
 */

// ── Types mirrored from stores.svelte.ts ────────────────────────────────

type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

interface TaskAssignment {
	id: string;
	agentConfigId: string;
	agentName: string;
	isTeam: boolean;
	status: AssignmentStatus;
	assignedAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	subConversationId?: string;
	agentRunId?: string;
	resultPreview?: string;
}

// ── Pure logic extracted from AssignmentPill.svelte ──────────────────────

/**
 * Returns the CSS class(es) / visual indicator description for a given status.
 * Mirrors the {#if} chain at lines 57–72 of AssignmentPill.svelte.
 *
 * Returns a discriminated tag so tests aren't coupled to exact markup:
 *   "gray-dot" | "blue-pulse" | "green-check" | "red-x"
 */
function statusIndicator(status: AssignmentStatus): "gray-dot" | "blue-pulse" | "green-check" | "red-x" {
	switch (status) {
		case "assigned":
			return "gray-dot";
		case "running":
			return "blue-pulse";
		case "completed":
			return "green-check";
		case "failed":
			return "red-x";
	}
}

/**
 * Mirrors `formatDuration` at lines 26–36 of AssignmentPill.svelte.
 */
function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${totalHours}h ${minutes.toString().padStart(2, "0")}m`;
}

/**
 * Mirrors `elapsed` derivation at lines 38–41 of AssignmentPill.svelte.
 * Returns the elapsed timer string, or null when no timer should show.
 */
function elapsed(assignment: TaskAssignment, now: number): string | null {
	if (assignment.status !== "running" || !assignment.startedAt) return null;
	return formatDuration(now - Date.parse(assignment.startedAt));
}

/**
 * Mirrors `isClickable` derivation at lines 43–46 of AssignmentPill.svelte.
 * The component takes `onstart` and `onclick` props — we model their
 * presence as booleans.
 */
function isClickable(
	assignment: TaskAssignment,
	hasOnstart: boolean,
	hasOnclick: boolean,
): boolean {
	return (
		(assignment.status === "assigned" && hasOnstart) ||
		(assignment.status !== "assigned" && hasOnclick)
	);
}

/**
 * Whether the start/play button is visible.
 * Mirrors lines 94–108: shown only when status === "assigned" AND onstart is provided.
 */
function showStartButton(assignment: TaskAssignment, hasOnstart: boolean): boolean {
	return assignment.status === "assigned" && hasOnstart;
}

/**
 * Which start-button variant to render. Mirrors the updated AssignmentPill
 * when the `blocked` prop is true — the play button is replaced with a
 * disabled lock icon that shows a tooltip naming the blocking tasks.
 *
 * Returns:
 *   "play"    — normal clickable play button
 *   "locked"  — disabled lock icon (blocked by unsatisfied prereqs)
 *   "spinner" — starting state (user clicked play)
 *   "hidden"  — not applicable (assignment isn't in "assigned" state)
 */
function startButtonVariant(
	assignment: TaskAssignment,
	hasOnstart: boolean,
	blocked: boolean,
	starting: boolean,
): "play" | "locked" | "spinner" | "hidden" {
	if (!showStartButton(assignment, hasOnstart)) return "hidden";
	if (starting) return "spinner";
	if (blocked) return "locked";
	return "play";
}

/** Tooltip text used on the locked start button. Mirrors the title attribute. */
function blockedTooltip(blockedBy: string[]): string {
	return blockedBy.length > 0
		? `Waiting for prerequisites: ${blockedBy.join(", ")}`
		: "Waiting for prerequisites to complete";
}

/**
 * Whether the team icon is rendered.
 * Mirrors line 81: `{#if assignment.isTeam}`.
 */
function showTeamIndicator(assignment: TaskAssignment): boolean {
	return assignment.isTeam;
}

// ── Factory ─────────────────────────────────────────────────────────────

let _id = 0;
function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
	return {
		id: overrides.id ?? `asgn-${++_id}`,
		agentConfigId: overrides.agentConfigId ?? "cfg-1",
		agentName: overrides.agentName ?? "coder",
		isTeam: overrides.isTeam ?? false,
		status: overrides.status ?? "assigned",
		assignedAt: overrides.assignedAt ?? "2026-01-01T00:00:00Z",
		startedAt: overrides.startedAt,
		completedAt: overrides.completedAt,
		failedAt: overrides.failedAt,
		subConversationId: overrides.subConversationId,
		agentRunId: overrides.agentRunId,
		resultPreview: overrides.resultPreview,
	};
}

// ── statusIndicator ─────────────────────────────────────────────────────

describe("statusIndicator", () => {
	test("assigned → gray dot", () => {
		expect(statusIndicator("assigned")).toBe("gray-dot");
	});

	test("running → blue pulsing dot", () => {
		expect(statusIndicator("running")).toBe("blue-pulse");
	});

	test("completed → green check", () => {
		expect(statusIndicator("completed")).toBe("green-check");
	});

	test("failed → red X", () => {
		expect(statusIndicator("failed")).toBe("red-x");
	});
});

// ── elapsed (timer display) ─────────────────────────────────────────────

describe("elapsed timer", () => {
	test("running with startedAt 30s ago → '30s'", () => {
		const startedAt = "2026-01-01T12:00:00Z";
		const now = Date.parse("2026-01-01T12:00:30Z");
		const a = makeAssignment({ status: "running", startedAt });
		expect(elapsed(a, now)).toBe("30s");
	});

	test("running with startedAt 2m 15s ago → '2m 15s'", () => {
		const startedAt = "2026-01-01T12:00:00Z";
		const now = Date.parse("2026-01-01T12:02:15Z");
		const a = makeAssignment({ status: "running", startedAt });
		expect(elapsed(a, now)).toBe("2m 15s");
	});

	test("running with startedAt 1h 7m ago → '1h 07m'", () => {
		const startedAt = "2026-01-01T12:00:00Z";
		const now = Date.parse("2026-01-01T13:07:00Z");
		const a = makeAssignment({ status: "running", startedAt });
		expect(elapsed(a, now)).toBe("1h 07m");
	});

	test("assigned (no startedAt) → null", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(elapsed(a, Date.now())).toBeNull();
	});

	test("running but no startedAt → null", () => {
		const a = makeAssignment({ status: "running" });
		expect(elapsed(a, Date.now())).toBeNull();
	});

	test("completed → null (timer only shows for running)", () => {
		const a = makeAssignment({
			status: "completed",
			startedAt: "2026-01-01T12:00:00Z",
			completedAt: "2026-01-01T12:05:00Z",
		});
		expect(elapsed(a, Date.now())).toBeNull();
	});

	test("failed → null", () => {
		const a = makeAssignment({
			status: "failed",
			startedAt: "2026-01-01T12:00:00Z",
			failedAt: "2026-01-01T12:00:10Z",
		});
		expect(elapsed(a, Date.now())).toBeNull();
	});

	test("timer ticks forward as now advances", () => {
		const startedAt = "2026-01-01T00:00:00Z";
		const a = makeAssignment({ status: "running", startedAt });
		const base = Date.parse(startedAt);
		const samples = [0, 1, 5, 30, 59, 60, 90].map((sec) =>
			elapsed(a, base + sec * 1000),
		);
		expect(samples).toEqual(["0s", "1s", "5s", "30s", "59s", "1m 00s", "1m 30s"]);
	});
});

// ── formatDuration ──────────────────────────────────────────────────────

describe("formatDuration", () => {
	test("negative → '0s'", () => {
		expect(formatDuration(-100)).toBe("0s");
	});

	test("sub-second → '0s'", () => {
		expect(formatDuration(500)).toBe("0s");
	});

	test("exact seconds", () => {
		expect(formatDuration(45_000)).toBe("45s");
	});

	test("minutes and seconds with zero-padding", () => {
		expect(formatDuration(65_000)).toBe("1m 05s");
	});

	test("hours and minutes with zero-padding", () => {
		expect(formatDuration(3600_000 + 7 * 60_000)).toBe("1h 07m");
	});
});

// ── isClickable ─────────────────────────────────────────────────────────

describe("isClickable", () => {
	test("assigned + onstart provided → true", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(isClickable(a, true, false)).toBe(true);
	});

	test("assigned + no onstart → false", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(isClickable(a, false, false)).toBe(false);
	});

	test("assigned + onclick only → false (assigned only reacts to onstart)", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(isClickable(a, false, true)).toBe(false);
	});

	test("running + onclick provided → true", () => {
		const a = makeAssignment({ status: "running" });
		expect(isClickable(a, false, true)).toBe(true);
	});

	test("completed + onclick provided → true", () => {
		const a = makeAssignment({ status: "completed" });
		expect(isClickable(a, false, true)).toBe(true);
	});

	test("failed + onclick provided → true", () => {
		const a = makeAssignment({ status: "failed" });
		expect(isClickable(a, false, true)).toBe(true);
	});

	test("running + no onclick → false", () => {
		const a = makeAssignment({ status: "running" });
		expect(isClickable(a, false, false)).toBe(false);
	});

	test("running + both handlers → true (onclick wins for non-assigned)", () => {
		const a = makeAssignment({ status: "running" });
		expect(isClickable(a, true, true)).toBe(true);
	});
});

// ── showStartButton ─────────────────────────────────────────────────────

describe("showStartButton", () => {
	test("assigned + onstart → visible", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(showStartButton(a, true)).toBe(true);
	});

	test("assigned + no onstart → hidden", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(showStartButton(a, false)).toBe(false);
	});

	test("running → hidden regardless of onstart", () => {
		const a = makeAssignment({ status: "running" });
		expect(showStartButton(a, true)).toBe(false);
	});

	test("completed → hidden", () => {
		const a = makeAssignment({ status: "completed" });
		expect(showStartButton(a, true)).toBe(false);
	});

	test("failed → hidden", () => {
		const a = makeAssignment({ status: "failed" });
		expect(showStartButton(a, true)).toBe(false);
	});
});

// ── startButtonVariant (blocked/locked state) ───────────────────────────

describe("startButtonVariant", () => {
	test("assigned + unblocked + onstart → play button", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(startButtonVariant(a, true, false, false)).toBe("play");
	});

	test("assigned + blocked → locked (disabled) button", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(startButtonVariant(a, true, true, false)).toBe("locked");
	});

	test("assigned + starting → spinner (supersedes blocked/play)", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(startButtonVariant(a, true, false, true)).toBe("spinner");
		// starting should also win over blocked
		expect(startButtonVariant(a, true, true, true)).toBe("spinner");
	});

	test("running → hidden regardless of blocked state", () => {
		const a = makeAssignment({ status: "running" });
		expect(startButtonVariant(a, true, true, false)).toBe("hidden");
		expect(startButtonVariant(a, true, false, false)).toBe("hidden");
	});

	test("completed → hidden regardless of blocked state", () => {
		const a = makeAssignment({ status: "completed" });
		expect(startButtonVariant(a, true, true, false)).toBe("hidden");
	});

	test("no onstart handler → hidden", () => {
		const a = makeAssignment({ status: "assigned" });
		expect(startButtonVariant(a, false, false, false)).toBe("hidden");
	});
});

describe("blockedTooltip", () => {
	test("single blocker", () => {
		expect(blockedTooltip(["Build"])).toBe("Waiting for prerequisites: Build");
	});

	test("multiple blockers joined by comma", () => {
		expect(blockedTooltip(["Build", "Test"])).toBe("Waiting for prerequisites: Build, Test");
	});

	test("empty list falls back to generic message", () => {
		expect(blockedTooltip([])).toBe("Waiting for prerequisites to complete");
	});
});

// ── showTeamIndicator ───────────────────────────────────────────────────

describe("showTeamIndicator", () => {
	test("isTeam=true → show team icon", () => {
		const a = makeAssignment({ isTeam: true });
		expect(showTeamIndicator(a)).toBe(true);
	});

	test("isTeam=false → no team icon", () => {
		const a = makeAssignment({ isTeam: false });
		expect(showTeamIndicator(a)).toBe(false);
	});
});

// ── Combined scenario ───────────────────────────────────────────────────

describe("combined scenario", () => {
	test("running team assignment shows blue pulse, timer, team icon, no start button, and is clickable with onclick", () => {
		const a = makeAssignment({
			status: "running",
			isTeam: true,
			startedAt: "2026-01-01T00:00:00Z",
			agentName: "ops-team",
		});
		const now = Date.parse("2026-01-01T00:01:30Z");

		expect(statusIndicator(a.status)).toBe("blue-pulse");
		expect(elapsed(a, now)).toBe("1m 30s");
		expect(showTeamIndicator(a)).toBe(true);
		expect(showStartButton(a, true)).toBe(false);
		expect(isClickable(a, false, true)).toBe(true);
	});

	test("assigned solo agent shows gray dot, no timer, start button, no team icon", () => {
		const a = makeAssignment({
			status: "assigned",
			isTeam: false,
			agentName: "coder",
		});

		expect(statusIndicator(a.status)).toBe("gray-dot");
		expect(elapsed(a, Date.now())).toBeNull();
		expect(showTeamIndicator(a)).toBe(false);
		expect(showStartButton(a, true)).toBe(true);
		expect(isClickable(a, true, false)).toBe(true);
	});
});
