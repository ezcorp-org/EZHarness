import { afterEach, describe, expect, test, vi } from "vitest";
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

const runEvent = (sequence: number) => JSON.stringify({ schemaVersion: "factory.run-event.v1", runId: "run-1", sequence, eventId: "e".repeat(64), payloadBytes: 2, payload: {} });
const event = (sequence: number, id: string | null = `tok-${sequence}`) => `${id === null ? "" : `id: ${id}\n`}event: factory:run-event\ndata: ${runEvent(sequence)}\n\n`;
const status = (sequence: number, drained = false, id: string | null = `tok-${sequence}`) => `${id === null ? "" : `id: ${id}\n`}event: factory:run-status\ndata: ${JSON.stringify({ status: drained ? "succeeded" : "running", sequence, drained })}\n\n`;
const closed = (reason: string) => `event: factory:stream-closed\ndata: {"reason":"${reason}"}\n\n`;
const refusal = (code: number) => Object.assign(new Error(`status ${code}`), { status: code });

/**
 * A scripted response body. Each chunk is read once; then the body ends, fails, or holds until the
 * stream aborts it. A read past the end is a defect in the stream (it would spin), so the body
 * reports a violation and never answers again. `released` says whether the reader lock was given back.
 */
interface ScriptedBody { readonly body: ReadableStream<Uint8Array>; readonly released: () => boolean; readonly signal: AbortSignal }
type Chunk = string | Uint8Array;
type BodyOptions = { readonly hold?: boolean; readonly fail?: boolean };

/** A strict harness: every snapshot and open is scripted, and anything past the script is a violation that stops the stream. */
function harness(opens: ReadonlyArray<BodyOptions & { chunks?: readonly Chunk[]; refuse?: number | null }>, snapshots: ReadonlyArray<FactoryRunInspection | Error | null>, extra: { maxReconnects?: number; backoffMs?: (attempt: number) => number; withoutOnEvent?: boolean } = {}) {
	const statuses: FactoryRunStreamStatus[] = [];
	const cursors: string[] = [];
	const applied: number[] = [];
	const snaps: FactoryRunInspection[] = [];
	const sleeps: number[] = [];
	const signals: AbortSignal[] = [];
	const bodies: ScriptedBody[] = [];
	const violations: string[] = [];
	let reportViolation: (reason: string) => void = () => undefined;
	const violated = new Promise<string>(resolve => { reportViolation = resolve; });
	let openIndex = 0;
	let snapIndex = 0;
	function violation(reason: string): void {
		violations.push(reason);
		reportViolation(reason);
		stream.stop();
	}
	function scripted(chunks: readonly Chunk[], options: BodyOptions, signal: AbortSignal): ScriptedBody {
		const queue = [...chunks];
		let ended = false;
		let released = false;
		const reader = {
			read(): Promise<ReadableStreamReadResult<Uint8Array>> {
				const next = queue.shift();
				if (next !== undefined) return Promise.resolve({ done: false, value: typeof next === "string" ? encoder.encode(next) : next });
				if (ended) { violation("read past the end of a body"); return new Promise(() => undefined); }
				ended = true;
				if (options.fail) return Promise.reject(new Error("network dropped"));
				if (options.hold) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
				return Promise.resolve({ done: true, value: undefined });
			},
			releaseLock() { released = true; },
		};
		return { body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>, released: () => released, signal };
	}
	const stream: FactoryRunStream = new FactoryRunStream({
		snapshot: async () => {
			const next = snapshots[snapIndex++];
			if (next === undefined) { violation("snapshot past the script"); throw new Error("script exhausted"); }
			if (next instanceof Error || next === null) throw next;
			return next;
		},
		open: async (cursor, signal) => {
			cursors.push(cursor);
			signals.push(signal);
			const next = opens[openIndex++];
			if (next === undefined) { violation("open past the script"); throw new Error("script exhausted"); }
			if (next.refuse !== undefined) throw next.refuse === null ? null : refusal(next.refuse);
			const made = scripted(next.chunks ?? [], next, signal);
			bodies.push(made);
			return made.body;
		},
		onSnapshot: value => snaps.push(value),
		onStatus: value => statuses.push(value),
		...(extra.withoutOnEvent ? {} : { onEvent: value => applied.push(value.sequence) }),
		sleep: async ms => { sleeps.push(ms); if (sleeps.length > 20) violation("backoff never ended"); },
		backoffMs: extra.backoffMs ?? (attempt => 100 * (attempt + 1)),
		...(extra.maxReconnects === undefined ? {} : { maxReconnects: extra.maxReconnects }),
	});
	/** The final status; a violation fails the test at once instead of letting the stream spin. */
	async function run(): Promise<FactoryRunStreamStatus> {
		// A stream that neither ends nor breaks its script within two seconds is hung: fail now, never time out.
		const deadline = new Promise<string>(resolve => setTimeout(() => resolve("no outcome within 2 s"), 2_000));
		const outcome = await Promise.race([stream.run().then(final => ({ final })), violated.then(reason => ({ reason })), deadline.then(reason => ({ reason }))]);
		if ("reason" in outcome) throw new Error(`the stream went past its script: ${outcome.reason}`);
		expect(violations).toEqual([]);
		// Every body the stream opened was given back, and its signal aborted when the stream left it.
		expect(bodies.map(item => item.released())).toEqual(bodies.map(() => true));
		expect(bodies.map(item => item.signal.aborted)).toEqual(bodies.map(() => true));
		return outcome.final;
	}
	return { stream, run, statuses, cursors, applied, snaps, sleeps, states: () => statuses.map(item => item.state) };
}

const body = (chunks: readonly Chunk[], options: BodyOptions = {}) => ({ chunks, ...options });

describe("parseSseFrames", () => {
	test("splits complete frames, keeps the unfinished tail, and ignores comments and unknown fields", () => {
		const parsed = parseSseFrames(": keep-alive\n\nid: 7\nevent: a\ndata: one\ndata:two\nretry: 5\n\nevent: b\r\ndata: x\r\n\r\nevent: c\ndata: partial");
		expect(parsed.frames).toStrictEqual([{ event: "a", data: "one\ntwo", id: "7" }, { event: "b", data: "x" }]);
		expect(parsed.rest).toBe("event: c\ndata: partial");
		expect(parseSseFrames("data\n\n").frames).toStrictEqual([{ event: "message", data: "" }]);
		expect(parseSseFrames("event: only\n\n").frames).toStrictEqual([]);
		expect(parseSseFrames("data:  two spaces\n\n").frames[0]!.data).toBe(" two spaces");
		expect(parseSseFrames("")).toStrictEqual({ frames: [], rest: "" });
	});

	test("a lone carriage return ends a line, a field may be empty, and only one leading space is dropped", () => {
		expect(parseSseFrames("event: b\rdata: x\r\r").frames).toStrictEqual([{ event: "b", data: "x" }]);
		// A field line that ends with a colon is a field, not a comment.
		expect(parseSseFrames("event: a\ndata:\n\n").frames).toStrictEqual([{ event: "a", data: "" }]);
		expect(parseSseFrames("data:a b\n\n").frames).toStrictEqual([{ event: "message", data: "a b" }]);
		// An empty id is still an id: the resume cursor is reset by it.
		expect(parseSseFrames("id:\ndata: x\n\n").frames).toStrictEqual([{ event: "message", data: "x", id: "" }]);
		expect(parseSseFrames("data: x\n\n").frames[0]).not.toHaveProperty("id");
		expect(parseSseFrames("\n\n\ndata: late\n\n").frames).toStrictEqual([{ event: "message", data: "late" }]);
	});
});

describe("FactoryRunStream", () => {
	test("starts connecting with nothing applied", () => {
		const h = harness([], []);
		expect(h.stream.current).toStrictEqual({ state: "connecting", applied: 0, duplicates: 0, gaps: 0, reconnects: 0, lag: 0 });
	});

	test("applies only the next sequence, counts duplicates, refreshes once, and ends when drained", async () => {
		const h = harness([body([event(2) + event(2) + event(1), event(3) + status(3, true) + closed("drained")])], [inspection(1), inspection(3)]);
		const final = await h.run();
		expect(h.applied).toEqual([2, 3]);
		expect(final).toStrictEqual({ state: "ended", applied: 3, duplicates: 2, gaps: 0, reconnects: 0, lag: 0, reason: "drained" });
		expect(h.cursors).toEqual(["snap-1"]);
		expect(h.snaps.map(item => item.cursor.sequence)).toEqual([1, 3]);
		expect(h.states()).toEqual(["connecting", "connecting", "live", "live", "live", "live", "live", "live", "live", "ended"]);
		expect(h.statuses.map(item => [item.applied, item.duplicates])).toEqual([[0, 0], [1, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 2], [3, 2], [3, 2], [3, 2]]);
		expect(h.sleeps).toEqual([]);
	});

	test("a gap reopens from the last applied cursor, and the catch-up is visible", async () => {
		const h = harness([body([event(2) + event(4)], { hold: true }), body([event(3) + event(4) + status(4, true) + closed("drained")])], [inspection(1), inspection(4)]);
		const final = await h.run();
		expect(h.cursors).toEqual(["snap-1", "tok-2"]);
		expect(h.applied).toEqual([2, 3, 4]);
		expect(final).toMatchObject({ state: "ended", gaps: 1, applied: 4, duplicates: 0 });
		expect(h.states()).toEqual(["connecting", "connecting", "live", "live", "catching-up", "live", "live", "live", "live", "live", "ended"]);
	});

	test("an event without an id keeps the resume cursor it had", async () => {
		const h = harness([body([event(2, null) + event(4)], { hold: true }), body([closed("drained")])], [inspection(1)]);
		await h.run();
		expect(h.cursors).toEqual(["snap-1", "snap-1"]);
		expect(h.applied).toEqual([2]);
	});

	test("a status ahead of the applied sequence is a gap too", async () => {
		const h = harness([body([status(5)], { hold: true }), body([closed("drained")])], [inspection(1)]);
		const final = await h.run();
		expect(final.gaps).toBe(1);
		expect(h.cursors).toEqual(["snap-1", "snap-1"]);
		expect(h.states()).toEqual(["connecting", "connecting", "live", "catching-up", "live", "ended"]);
	});

	test("an idle status advances the resume cursor without a refresh; an older one does not", async () => {
		const h = harness([body([status(0, false, "older") + status(1, false, "idle-1")], { fail: true }), body([closed("drained")])], [inspection(1)]);
		await h.run();
		expect(h.cursors).toEqual(["snap-1", "idle-1"]);
		expect(h.snaps).toHaveLength(1);
		// A dropped connection with a cursor reopens; it does not re-snapshot.
		expect(h.states()).toEqual(["connecting", "connecting", "live", "reconnecting", "live", "ended"]);
		expect(h.sleeps).toEqual([100]);
		expect(h.stream.current.reconnects).toBe(1);
	});

	test("an expired cursor takes a new snapshot; a 410 on open does too", async () => {
		const h = harness([body([closed("expired")]), { refuse: 410 }, body([closed("drained")])], [inspection(1, "a"), inspection(2, "b"), inspection(3, "c")]);
		await h.run();
		expect(h.cursors).toEqual(["a", "b", "c"]);
		expect(h.snaps.map(item => item.cursor.token)).toEqual(["a", "b", "c"]);
		expect(h.sleeps).toEqual([]);
	});

	test("revocation stops the view wherever it is noticed", async () => {
		const cases = [
			[[body([closed("revoked")])], [inspection(1)], "revoked"],
			[[body([closed("not-found")])], [inspection(1)], "not-found"],
			[[{ refuse: 403 }], [inspection(1)], "stream-refused"],
			[[], [refusal(403)], "snapshot-refused"],
			[[body([event(2) + status(2)], { hold: true })], [inspection(1), refusal(403)], "snapshot-refused"],
		] as const;
		for (const [opens, snapshots, reason] of cases) {
			const h = harness(opens, snapshots);
			expect(await h.run()).toMatchObject({ state: "revoked", reason });
			expect(h.states().at(-1)).toBe("revoked");
			expect(h.sleeps).toEqual([]);
		}
	});

	test("a refresh that fails for another reason keeps the view live", async () => {
		const h = harness([body([event(2) + status(2) + closed("drained")])], [inspection(1), refusal(503)]);
		expect(await h.run()).toMatchObject({ state: "ended", applied: 2 });
		expect(h.states()).toEqual(["connecting", "connecting", "live", "live", "live", "ended"]);
	});

	test("a lost service is retried with backoff and then shown offline, never as the last good status", async () => {
		const h = harness([{ refuse: 503 }, { refuse: 503 }, { refuse: 503 }], [inspection(1)], { maxReconnects: 2 });
		const final = await h.run();
		expect(final).toMatchObject({ state: "offline", reason: "reconnect-limit", reconnects: 2 });
		expect(h.sleeps).toEqual([100, 200]);
		expect(h.cursors).toEqual(["snap-1", "snap-1", "snap-1"]);
		expect(h.states()).toEqual(["connecting", "connecting", "reconnecting", "reconnecting", "offline"]);
		// Without a cursor it snapshots again; an error that is not a response (null) is a lost service too.
		const failing = harness([], [new Error("down"), null], { maxReconnects: 1 });
		expect(await failing.run()).toMatchObject({ state: "offline", reconnects: 1 });
		expect(failing.snaps).toHaveLength(0);
		expect(failing.sleeps).toEqual([100]);
		// A refusal that is not a response is retried, not revoked.
		const odd = harness([{ refuse: null }, body([closed("drained")])], [inspection(1)]);
		expect(await odd.run()).toMatchObject({ state: "ended", reconnects: 1 });
	});

	test("a good connection resets the retry count", async () => {
		// Two failures in a row are allowed. Without the reset after the good connection, the third would be one too many.
		const h = harness([{ refuse: 503 }, body([], { fail: true }), { refuse: 503 }, body([closed("drained")])], [inspection(1)], { maxReconnects: 2 });
		expect(await h.run()).toMatchObject({ state: "ended", reconnects: 3 });
		expect(h.sleeps).toEqual([100, 100, 200]);
	});

	test("the default backoff doubles from half a second and stops at thirty", async () => {
		const opens = Array.from({ length: 9 }, () => ({ refuse: 503 }));
		const h = harness(opens, [inspection(1)], { maxReconnects: 8, backoffMs: undefined });
		const withDefault: FactoryRunStream = new FactoryRunStream({
			snapshot: async () => inspection(1), open: async () => { throw refusal(503); }, onSnapshot: () => undefined, onStatus: () => undefined,
			sleep: async ms => { h.sleeps.push(ms); if (h.sleeps.length > 20) withDefault.stop(); }, maxReconnects: 8,
		});
		expect(await withDefault.run()).toMatchObject({ state: "offline", reconnects: 8 });
		expect(h.sleeps).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
		expect(new FactoryRunStream({ snapshot: vi.fn(), open: vi.fn(), onSnapshot: vi.fn(), onStatus: vi.fn() }).current.state).toBe("connecting");
	});

	test("five failed connections go offline by default", async () => {
		const sleeps: number[] = [];
		const stream: FactoryRunStream = new FactoryRunStream({ snapshot: async () => { throw refusal(503); }, open: vi.fn(), onSnapshot: vi.fn(), onStatus: vi.fn(), sleep: async ms => { sleeps.push(ms); if (sleeps.length > 20) stream.stop(); } });
		expect(await stream.run()).toMatchObject({ state: "offline", reconnects: 5 });
		expect(sleeps).toHaveLength(5);
	});

	test("a closed-for-deadline stream reopens at once, an unknown close backs off, and an unknown frame is ignored", async () => {
		const h = harness([body(["event: other\ndata: {}\n\n" + closed("deadline")]), body([closed("unavailable")]), body([closed("drained")])], [inspection(1)]);
		await h.run();
		expect(h.cursors).toEqual(["snap-1", "snap-1", "snap-1"]);
		expect(h.sleeps).toEqual([100]);
		expect(h.states()).toEqual(["connecting", "connecting", "live", "connecting", "live", "reconnecting", "live", "ended"]);
	});

	test("a projection that trails is shown as lagging until a refresh catches up", async () => {
		const h = harness([body([event(2) + status(2) + closed("drained")])], [inspection(1, "t", 3), inspection(2, "u", 0)]);
		await h.run();
		expect(h.states()).toEqual(["connecting", "connecting", "lagging", "lagging", "lagging", "live", "ended"]);
		expect(h.statuses.map(item => item.lag)).toEqual([0, 3, 3, 3, 0, 0, 0]);
		const still = harness([body([event(2) + status(2) + closed("drained")])], [inspection(1, "t", 3), inspection(2, "u", 2)]);
		await still.run();
		expect(still.states()).toEqual(["connecting", "connecting", "lagging", "lagging", "lagging", "lagging", "ended"]);
	});

	test("a status after a refresh does not refresh again until another event applies", async () => {
		const h = harness([body([event(2) + status(2) + status(2) + event(3) + status(3) + closed("drained")])], [inspection(1), inspection(2), inspection(3)]);
		await h.run();
		expect(h.snaps.map(item => item.cursor.sequence)).toEqual([1, 2, 3]);
	});

	test("an event is decoded across chunk boundaries, and a view with no event listener still applies it", async () => {
		const frame = encoder.encode(`id: tok-2\nevent: factory:run-event\ndata: ${JSON.stringify({ schemaVersion: "factory.run-event.v1", runId: "run-1", sequence: 2, eventId: "e".repeat(64), payloadBytes: 4, payload: { note: "café" } })}\n\n`);
		const split = frame.indexOf(0xc3) + 1;
		const h = harness([body([frame.slice(0, split), frame.slice(split), closed("drained")])], [inspection(1)], { withoutOnEvent: true });
		expect(await h.run()).toMatchObject({ state: "ended", applied: 2 });
		const decoded: string[] = [];
		// A real body; any backoff means the stream did not end as drained, so it stops at once.
		const listening: FactoryRunStream = new FactoryRunStream({
			snapshot: async () => inspection(1),
			open: async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame.slice(0, split)); controller.enqueue(frame.slice(split)); controller.enqueue(encoder.encode(closed("drained"))); controller.close(); } }),
			onSnapshot: vi.fn(), onStatus: vi.fn(), onEvent: value => decoded.push(JSON.stringify(value.payload)),
			sleep: async () => { listening.stop(); },
		});
		expect(await listening.run()).toMatchObject({ state: "ended" });
		expect(decoded).toEqual(['{"note":"café"}']);
	});

	test("stop() ends a held stream and the default sleep wakes on abort", async () => {
		const statuses: string[] = [];
		const stream = new FactoryRunStream({
			snapshot: async () => inspection(1),
			open: async (_cursor, signal) => new ReadableStream<Uint8Array>({ start(controller) { signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); } }),
			onSnapshot: () => undefined,
			onStatus: value => { statuses.push(value.state); if (value.state === "live") queueMicrotask(() => stream.stop()); },
		});
		const held = await Promise.race([stream.run().then(final => final.state), new Promise(resolve => setTimeout(() => resolve("never stopped"), 1_000))]);
		expect(held).toBe("live");
		expect(statuses).toEqual(["connecting", "connecting", "live"]);
		const sleepy: FactoryRunStream = new FactoryRunStream({
			snapshot: async () => { throw new Error("down"); },
			open: vi.fn(),
			onSnapshot: () => undefined,
			onStatus: value => { if (value.state === "reconnecting") queueMicrotask(() => sleepy.stop()); },
			backoffMs: () => 60_000, maxReconnects: 1,
		});
		// The default sleep wakes on the abort: the view never waits out its minute.
		const woke = await Promise.race([sleepy.run().then(final => final.state), new Promise(resolve => setTimeout(() => resolve("still asleep"), 1_000))]);
		expect(woke).toBe("reconnecting");
	});
});

describe("the default backoff sleep", () => {
	afterEach(() => { vi.useRealTimers(); });

	function sleeper(): { stream: FactoryRunStream; slept: () => Promise<FactoryRunStreamStatus> } {
		// One failed snapshot, then offline: the only sleep is the default one, for 1 000 ms.
		const stream = new FactoryRunStream({ snapshot: async () => { throw refusal(503); }, open: vi.fn(), onSnapshot: vi.fn(), onStatus: vi.fn(), maxReconnects: 1, backoffMs: () => 1_000 });
		return { stream, slept: () => stream.run() };
	}

	test("waits the full backoff, then lets go of the abort listener", async () => {
		vi.useFakeTimers();
		const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
		const { slept } = sleeper();
		let settled = false;
		const running = slept().then(value => { settled = true; return value; });
		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		// Checked before awaiting, so a sleep that never ends fails here instead of hanging the test.
		expect(settled).toBe(true);
		expect((await running).state).toBe("offline");
		expect(removed.mock.calls.some(([type]) => type === "abort")).toBe(true);
		removed.mockRestore();
	});

	test("an abort wakes it before the backoff ends and clears its timer", async () => {
		vi.useFakeTimers();
		const cleared = vi.spyOn(globalThis, "clearTimeout");
		const { stream, slept } = sleeper();
		let settled = false;
		const running = slept().then(value => { settled = true; return value; });
		await vi.advanceTimersByTimeAsync(10);
		stream.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		expect((await running).state).toBe("reconnecting");
		expect(cleared).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		cleared.mockRestore();
	});

	test("an already stopped view does not wait at all", async () => {
		vi.useFakeTimers();
		// Stopped as the view shows it is reconnecting, so the sleep begins already aborted.
		const stream: FactoryRunStream = new FactoryRunStream({
			snapshot: async () => { throw refusal(503); }, open: vi.fn(), onSnapshot: vi.fn(),
			onStatus: value => { if (value.state === "reconnecting") stream.stop(); }, backoffMs: () => 60_000,
		});
		let settled = false;
		const running = stream.run().then(value => { settled = true; return value; });
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		expect((await running).state).toBe("reconnecting");
		expect(vi.getTimerCount()).toBe(0);
	});
});
