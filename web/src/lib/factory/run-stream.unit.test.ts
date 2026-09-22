import { describe, expect, test, vi } from "vitest";
import type { FactoryRunInspection } from "@ezcorp/factory-sdk/types";
import { FactoryRunStream, parseSseFrames, type FactoryRunStreamStatus } from "./run-stream";

const encoder = new TextEncoder();

function inspection(sequence: number, token = `snap-${sequence}`, projectionLag = 0): FactoryRunInspection {
	return {
		run: { runId: "run-1", factoryId: "f", factoryVersion: "1", definitionDigest: `sha256:${"a".repeat(64)}`, grantRevision: 1, revision: 1, status: "running", createdAtMs: 1, updatedAtMs: 1, parameters: {} },
		cursor: { token, sequence, expiresAtMs: 9 }, projectionLag,
		children: { items: [] }, attempts: { items: [] }, artifacts: { items: [] }, blockers: [], acceptance: [], releases: [],
		costs: { limitMicros: "0", allocatedMicros: "0", spentMicros: "0", knownCostMicros: "0", unknownCostMicros: "0", admissionBlocked: false, uncertain: false },
	} as FactoryRunInspection;
}

const event = (sequence: number, id = `tok-${sequence}`) => `id: ${id}\nevent: factory:run-event\ndata: ${JSON.stringify({ schemaVersion: "factory.run-event.v1", runId: "run-1", sequence, eventId: "e".repeat(64), payloadBytes: 2, payload: {} })}\n\n`;
const status = (sequence: number, drained = false, id = `tok-${sequence}`) => `id: ${id}\nevent: factory:run-status\ndata: ${JSON.stringify({ status: drained ? "succeeded" : "running", sequence, drained })}\n\n`;
const closed = (reason: string) => `event: factory:stream-closed\ndata: {"reason":"${reason}"}\n\n`;

/** A body that yields each chunk, then ends (or stays open until aborted when `hold`). */
function body(chunks: readonly string[], options: { hold?: boolean; signal?: AbortSignal; fail?: boolean } = {}): ReadableStream<Uint8Array> {
	const queue = [...chunks];
	return new ReadableStream<Uint8Array>({
		start(controller) {
			options.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
		},
		// Pull-driven, so a failure arrives only after every chunk was read, as a dropped socket does.
		pull(controller) {
			const next = queue.shift();
			if (next !== undefined) { controller.enqueue(encoder.encode(next)); return; }
			if (options.fail) { controller.error(new Error("network dropped")); return; }
			if (!options.hold) controller.close();
			return new Promise<void>(() => undefined);
		},
	});
}

function harness(opens: Array<(signal: AbortSignal, cursor: string) => ReadableStream<Uint8Array> | Promise<never>>, snapshots: Array<FactoryRunInspection | Error>, extra: { maxReconnects?: number } = {}) {
	const statuses: FactoryRunStreamStatus[] = [];
	const cursors: string[] = [];
	const applied: number[] = [];
	const snaps: FactoryRunInspection[] = [];
	const sleeps: number[] = [];
	let openIndex = 0;
	let snapIndex = 0;
	const stream = new FactoryRunStream({
		snapshot: async () => {
			const next = snapshots[Math.min(snapIndex++, snapshots.length - 1)]!;
			if (next instanceof Error) throw next;
			return next;
		},
		open: async (cursor, signal) => {
			cursors.push(cursor);
			const factory = opens[Math.min(openIndex++, opens.length - 1)]!;
			return factory(signal, cursor);
		},
		onSnapshot: value => snaps.push(value),
		onStatus: value => statuses.push(value),
		onEvent: value => applied.push(value.sequence),
		sleep: async ms => { sleeps.push(ms); },
		backoffMs: attempt => 100 * (attempt + 1),
		...extra,
	});
	return { stream, statuses, cursors, applied, snaps, sleeps, states: () => statuses.map(item => item.state) };
}

const refusal = (status: number) => Object.assign(new Error(`status ${status}`), { status });

describe("parseSseFrames", () => {
	test("splits complete frames, keeps the unfinished tail, and ignores comments and unknown fields", () => {
		const parsed = parseSseFrames(": keep-alive\n\nid: 7\nevent: a\ndata: one\ndata:two\nretry: 5\n\nevent: b\r\ndata: x\r\n\r\nevent: c\ndata: partial");
		expect(parsed.frames).toEqual([{ event: "a", data: "one\ntwo", id: "7" }, { event: "b", data: "x" }]);
		expect(parsed.rest).toBe("event: c\ndata: partial");
		expect(parseSseFrames("data\n\n").frames).toEqual([{ event: "message", data: "" }]);
		expect(parseSseFrames("event: only\n\n").frames).toEqual([]);
		expect(parseSseFrames("data:  two spaces\n\n").frames[0]!.data).toBe(" two spaces");
		expect(parseSseFrames("")).toEqual({ frames: [], rest: "" });
	});
});

describe("FactoryRunStream", () => {
	test("applies only the next sequence, counts duplicates, and ends when drained", async () => {
		const h = harness([() => body([event(2) + event(2) + event(1), event(3) + status(3, true) + closed("drained")])], [inspection(1), inspection(3)]);
		const final = await h.stream.run();
		expect(h.applied).toEqual([2, 3]);
		expect(final).toMatchObject({ state: "ended", applied: 3, duplicates: 2, gaps: 0, reason: "drained" });
		expect(h.cursors).toEqual(["snap-1"]);
		// The first snapshot, then one refresh when the drained status arrived after applied events.
		expect(h.snaps.map(item => item.cursor.sequence)).toEqual([1, 3]);
		expect(h.states()).toContain("live");
	});

	test("a gap reopens from the last applied cursor, and the catch-up is visible", async () => {
		const h = harness([
			() => body([event(2) + event(4)], { hold: true }),
			() => body([event(3) + event(4) + status(4, true) + closed("drained")]),
		], [inspection(1)]);
		const final = await h.stream.run();
		expect(h.cursors).toEqual(["snap-1", "tok-2"]);
		expect(h.applied).toEqual([2, 3, 4]);
		expect(final).toMatchObject({ state: "ended", gaps: 1 });
		expect(h.states()).toContain("catching-up");
	});

	test("a status ahead of the applied sequence is a gap too", async () => {
		const h = harness([() => body([status(5)], { hold: true }), () => body([closed("drained")])], [inspection(1)]);
		const final = await h.stream.run();
		expect(final.gaps).toBe(1);
		expect(h.cursors).toEqual(["snap-1", "snap-1"]);
	});

	test("an idle status advances the resume cursor without a refresh", async () => {
		const h = harness([() => body([status(1, false, "idle-1")], { fail: true }), () => body([closed("drained")])], [inspection(1)]);
		await h.stream.run();
		expect(h.cursors).toEqual(["snap-1", "idle-1"]);
		expect(h.snaps).toHaveLength(1);
		// A dropped connection with a cursor reopens; it does not re-snapshot.
		expect(h.states()).toContain("reconnecting");
		expect(h.sleeps).toEqual([100]);
	});

	test("an expired cursor takes a new snapshot; a 410 on open does too", async () => {
		const h = harness([
			() => body([closed("expired")]),
			() => Promise.reject(refusal(410)),
			() => body([closed("drained")]),
		], [inspection(1, "a"), inspection(2, "b"), inspection(3, "c")]);
		await h.stream.run();
		expect(h.cursors).toEqual(["a", "b", "c"]);
		expect(h.snaps.map(item => item.cursor.token)).toEqual(["a", "b", "c"]);
	});

	test("revocation stops the view wherever it is noticed", async () => {
		for (const [opens, snapshots, reason] of [
			[[() => body([closed("revoked")])], [inspection(1)], "revoked"],
			[[() => body([closed("not-found")])], [inspection(1)], "not-found"],
			[[() => Promise.reject(refusal(403))], [inspection(1)], "stream-refused"],
			[[() => body([])], [refusal(403)], "snapshot-refused"],
			[[() => body([event(2) + status(2)], { hold: true })], [inspection(1), refusal(403)], "snapshot-refused"],
		] as const) {
			const h = harness(opens as never, snapshots as never);
			const final = await h.stream.run();
			expect(final).toMatchObject({ state: "revoked", reason });
		}
	});

	test("a lost service is retried with backoff and then shown offline, never as the last good status", async () => {
		const h = harness([() => Promise.reject(refusal(503))], [inspection(1)], { maxReconnects: 2 });
		const final = await h.stream.run();
		expect(final).toMatchObject({ state: "offline", reason: "reconnect-limit", reconnects: 2 });
		expect(h.sleeps).toEqual([100, 200]);
		const failing = harness([() => body([])], [new Error("down")], { maxReconnects: 1 });
		expect((await failing.stream.run()).state).toBe("offline");
		expect(failing.snaps).toHaveLength(0);
	});

	test("a closed-for-deadline stream reopens at once, an unknown close backs off, and an unknown frame is ignored", async () => {
		const h = harness([
			() => body(["event: other\ndata: {}\n\n" + closed("deadline")]),
			() => body([closed("unavailable")]),
			() => body([closed("drained")]),
		], [inspection(1)]);
		await h.stream.run();
		expect(h.cursors).toEqual(["snap-1", "snap-1", "snap-1"]);
		expect(h.sleeps).toEqual([100]);
	});

	test("a projection that trails is shown as lagging until a refresh catches up", async () => {
		const h = harness([() => body([event(2) + status(2) + closed("drained")])], [inspection(1, "t", 3), inspection(2, "u", 0)]);
		await h.stream.run();
		expect(h.states().slice(0, 3)).toEqual(["connecting", "connecting", "lagging"]);
		expect(h.states()).toContain("live");
		expect(h.stream.current.lag).toBe(0);
	});

	test("stop() ends a held stream and the default sleep wakes on abort", async () => {
		const statuses: string[] = [];
		const stream = new FactoryRunStream({
			snapshot: async () => inspection(1),
			open: async (_cursor, signal) => body([], { hold: true, signal }),
			onSnapshot: () => undefined,
			onStatus: value => { statuses.push(value.state); if (value.state === "live") queueMicrotask(() => stream.stop()); },
		});
		const final = await stream.run();
		expect(final.state).toBe("live");
		const sleepy = new FactoryRunStream({
			snapshot: async () => { throw new Error("down"); },
			open: vi.fn(),
			onSnapshot: () => undefined,
			onStatus: value => { if (value.state === "reconnecting") queueMicrotask(() => sleepy.stop()); },
		});
		expect((await sleepy.run()).state).toBe("reconnecting");
		const slow = new FactoryRunStream({ snapshot: async () => { throw new Error("down"); }, open: vi.fn(), onSnapshot: () => undefined, onStatus: () => undefined, backoffMs: () => 1, maxReconnects: 1 });
		expect((await slow.run()).state).toBe("offline");
	});
});
