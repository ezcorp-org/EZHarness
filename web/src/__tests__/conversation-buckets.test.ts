/**
 * Phase 52.3 — bucketing logic for the per-conversation audit
 * timeline. Verifies entries align to messages by chronology so the
 * page can display "calls between turn N and turn N+1".
 */
import { test, expect, describe } from "bun:test";
import {
	bucketEntriesByMessage,
	type BucketableMessage,
	type BucketableEntry,
} from "../lib/audit/conversation-buckets";

function msg(id: string, ts: string, role = "user"): BucketableMessage {
	return { id, role, createdAt: ts };
}

function entry(id: string, ts: string): BucketableEntry {
	return { id, createdAt: ts };
}

describe("bucketEntriesByMessage", () => {
	test("entries fire between messages → assigned to preceding message", () => {
		const messages = [
			msg("m1", "2026-05-01T10:00:00Z"),
			msg("m2", "2026-05-01T10:05:00Z", "assistant"),
			msg("m3", "2026-05-01T10:10:00Z"),
		];
		const entries = [
			entry("e1", "2026-05-01T10:01:00Z"), // between m1 and m2
			entry("e2", "2026-05-01T10:06:00Z"), // between m2 and m3
			entry("e3", "2026-05-01T10:11:00Z"), // after m3
		];
		const result = bucketEntriesByMessage(messages, entries);
		expect(result.byMessage.get("m1")?.map((e) => e.id)).toEqual(["e1"]);
		expect(result.byMessage.get("m2")?.map((e) => e.id)).toEqual(["e2"]);
		expect(result.byMessage.get("m3")?.map((e) => e.id)).toEqual(["e3"]);
		expect(result.beforeFirst).toEqual([]);
	});

	test("entries before first message land in beforeFirst", () => {
		const messages = [msg("m1", "2026-05-01T10:00:00Z")];
		const entries = [entry("e1", "2026-05-01T09:00:00Z")];
		const result = bucketEntriesByMessage(messages, entries);
		expect(result.beforeFirst.map((e) => e.id)).toEqual(["e1"]);
		expect(result.byMessage.size).toBe(0);
	});

	test("entries equal-to message createdAt go to that message (not the prior one)", () => {
		const messages = [
			msg("m1", "2026-05-01T10:00:00Z"),
			msg("m2", "2026-05-01T10:05:00Z"),
		];
		const entries = [entry("e1", "2026-05-01T10:05:00Z")];
		const result = bucketEntriesByMessage(messages, entries);
		expect(result.byMessage.get("m2")?.map((e) => e.id)).toEqual(["e1"]);
		expect(result.byMessage.get("m1")).toBeUndefined();
	});

	test("input arrays are not mutated", () => {
		const messages = [
			msg("m2", "2026-05-01T10:05:00Z"),
			msg("m1", "2026-05-01T10:00:00Z"),
		];
		const entries = [
			entry("e2", "2026-05-01T10:06:00Z"),
			entry("e1", "2026-05-01T10:01:00Z"),
		];
		const messagesCopy = [...messages];
		const entriesCopy = [...entries];
		bucketEntriesByMessage(messages, entries);
		expect(messages.map((m) => m.id)).toEqual(messagesCopy.map((m) => m.id));
		expect(entries.map((e) => e.id)).toEqual(entriesCopy.map((e) => e.id));
	});

	test("no messages → all entries become beforeFirst", () => {
		const entries = [
			entry("e1", "2026-05-01T10:00:00Z"),
			entry("e2", "2026-05-01T10:01:00Z"),
		];
		const result = bucketEntriesByMessage([], entries);
		expect(result.beforeFirst.map((e) => e.id)).toEqual(["e1", "e2"]);
	});

	test("multiple entries per message preserve chronological order within bucket", () => {
		const messages = [msg("m1", "2026-05-01T10:00:00Z")];
		const entries = [
			entry("e3", "2026-05-01T10:03:00Z"),
			entry("e1", "2026-05-01T10:01:00Z"),
			entry("e2", "2026-05-01T10:02:00Z"),
		];
		const result = bucketEntriesByMessage(messages, entries);
		expect(result.byMessage.get("m1")?.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
	});

	test("returns sortedMessages chronological even when input is not", () => {
		const messages = [
			msg("m3", "2026-05-01T10:10:00Z"),
			msg("m1", "2026-05-01T10:00:00Z"),
			msg("m2", "2026-05-01T10:05:00Z"),
		];
		const result = bucketEntriesByMessage(messages, []);
		expect(result.sortedMessages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
	});

	test("Date instances accepted (not just ISO strings)", () => {
		const messages = [
			{ id: "m1", role: "user", createdAt: new Date("2026-05-01T10:00:00Z") },
		];
		const entries = [{ id: "e1", createdAt: new Date("2026-05-01T10:01:00Z") }];
		const result = bucketEntriesByMessage(messages, entries);
		expect(result.byMessage.get("m1")?.map((e) => e.id)).toEqual(["e1"]);
	});
});
