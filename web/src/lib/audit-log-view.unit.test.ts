/**
 * Unit tests for the audit-log view logic (locked decision 7):
 * consecutive action+actor grouping and bucketed relative timestamps.
 */
import { describe, test, expect } from "vitest";
import { groupConsecutive, relativeTime, prettyMetadata, type AuditViewRow } from "./audit-log-view";

let seq = 0;
function row(action: string, userId: string | null, overrides: Partial<AuditViewRow> = {}): AuditViewRow {
	seq += 1;
	return {
		id: `row-${seq}`,
		userId,
		action,
		target: null,
		metadata: null,
		createdAt: "2026-06-11T10:00:00.000Z",
		...overrides,
	};
}

describe("groupConsecutive", () => {
	test("collapses a run of identical action + actor", () => {
		const rows = [row("auth:login", "u1"), row("auth:login", "u1"), row("auth:login", "u1")];
		const groups = groupConsecutive(rows);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.count).toBe(3);
		expect(groups[0]!.rows).toHaveLength(3);
		expect(groups[0]!.first).toBe(rows[0]!);
		expect(groups[0]!.id).toBe(rows[0]!.id);
	});

	test("single rows stay single", () => {
		const rows = [row("auth:login", "u1"), row("user:invited", "u1"), row("agent:shared", "u2")];
		const groups = groupConsecutive(rows);
		expect(groups).toHaveLength(3);
		expect(groups.every((g) => g.count === 1)).toBe(true);
	});

	test("actor change breaks the run even for the same action", () => {
		const rows = [row("auth:login", "u1"), row("auth:login", "u2"), row("auth:login", "u1")];
		expect(groupConsecutive(rows)).toHaveLength(3);
	});

	test("action change breaks the run for the same actor", () => {
		const rows = [row("auth:login", "u1"), row("auth:failed_login", "u1")];
		expect(groupConsecutive(rows)).toHaveLength(2);
	});

	test("non-adjacent identical rows do NOT merge (consecutive-only)", () => {
		const rows = [row("auth:login", "u1"), row("user:invited", "u1"), row("auth:login", "u1")];
		const groups = groupConsecutive(rows);
		expect(groups).toHaveLength(3);
	});

	test("null actors group together; null vs value does not", () => {
		const rows = [row("system:bump", null), row("system:bump", null), row("system:bump", "u1")];
		const groups = groupConsecutive(rows);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.count).toBe(2);
	});

	test("empty input → empty output", () => {
		expect(groupConsecutive([])).toEqual([]);
	});
});

describe("relativeTime", () => {
	const now = new Date("2026-06-11T12:00:00.000Z");

	test("seconds bucket", () => {
		expect(relativeTime("2026-06-11T11:59:26.000Z", now)).toBe("34s ago");
	});

	test("minutes bucket", () => {
		expect(relativeTime("2026-06-11T11:48:00.000Z", now)).toBe("12m ago");
	});

	test("hours bucket", () => {
		expect(relativeTime("2026-06-11T10:00:00.000Z", now)).toBe("2h ago");
	});

	test("days bucket", () => {
		expect(relativeTime("2026-06-06T12:00:00.000Z", now)).toBe("5d ago");
	});

	test("bucket boundaries", () => {
		expect(relativeTime(new Date(now.getTime() - 59_999), now)).toBe("59s ago");
		expect(relativeTime(new Date(now.getTime() - 60_000), now)).toBe("1m ago");
		expect(relativeTime(new Date(now.getTime() - 3_600_000), now)).toBe("1h ago");
		expect(relativeTime(new Date(now.getTime() - 86_400_000), now)).toBe("1d ago");
	});

	test("future and invalid timestamps clamp to 0s ago", () => {
		expect(relativeTime("2026-06-11T13:00:00.000Z", now)).toBe("0s ago");
		expect(relativeTime("not-a-date", now)).toBe("0s ago");
	});
});

describe("prettyMetadata", () => {
	test("pretty-prints objects with 2-space indent", () => {
		expect(prettyMetadata({ actor: "system", reason: "version-bump" })).toBe(
			'{\n  "actor": "system",\n  "reason": "version-bump"\n}',
		);
	});

	test("null metadata → dash", () => {
		expect(prettyMetadata(null)).toBe("-");
	});
});
