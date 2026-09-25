import type { FactoryRunEvent, FactoryRunInspection } from "@ezcorp/factory-sdk/types";
import { FACTORY_STREAM_EVENT_NAMES } from "$lib/runtime-event-names";

const [RUN_EVENT, RUN_STATUS, STREAM_CLOSED] = FACTORY_STREAM_EVENT_NAMES;

/** What the console shows about the live view. Every state is visible; none pretends to be live. */
export type FactoryStreamState = "connecting" | "live" | "lagging" | "catching-up" | "reconnecting" | "offline" | "ended" | "revoked";

export interface FactorySseFrame {
	readonly event: string;
	readonly data: string;
	readonly id?: string;
}

/**
 * Splits buffered SSE text into complete frames and the unfinished tail.
 * Comments and unknown fields are dropped; multi-line data is joined with a
 * newline, as the SSE grammar says.
 */
export function parseSseFrames(buffer: string): { readonly frames: FactorySseFrame[]; readonly rest: string } {
	const normalized = buffer.replace(/\r\n?/g, "\n");
	const blocks = normalized.split("\n\n");
	const rest = blocks.pop() ?? "";
	const frames: FactorySseFrame[] = [];
	for (const block of blocks) {
		let event = "message";
		let id: string | undefined;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line === "" || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") event = value;
			else if (field === "data") data.push(value);
			else if (field === "id") id = value;
		}
		if (data.length === 0) continue;
		frames.push(id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id });
	}
	return { frames, rest };
}

export interface FactoryRunStreamStatus {
	readonly state: FactoryStreamState;
	readonly applied: number;
	readonly duplicates: number;
	readonly gaps: number;
	readonly reconnects: number;
	readonly lag: number;
	readonly reason?: string;
}

export interface FactoryRunStreamOptions {
	readonly snapshot: () => Promise<FactoryRunInspection>;
	readonly open: (cursor: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
	readonly onSnapshot: (inspection: FactoryRunInspection) => void;
	readonly onStatus: (status: FactoryRunStreamStatus) => void;
	readonly onEvent?: (event: FactoryRunEvent) => void;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Consecutive failed connections before the view goes offline. */
	readonly maxReconnects?: number;
	readonly backoffMs?: (attempt: number) => number;
}

type Outcome = "snapshot" | "reopen" | "backoff" | "stop";

function statusCode(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(() => { signal.removeEventListener("abort", wake); resolve(); }, ms);
		const wake = () => { clearTimeout(timer); resolve(); };
		signal.addEventListener("abort", wake, { once: true });
	});
}

/**
 * The live run view (C09): an authenticated snapshot, then SSE from its cursor.
 * Only the next sequence is applied; older ones are counted as duplicates, and
 * a jump is a gap that reopens the stream from the last applied cursor. An
 * expired cursor takes a fresh snapshot. Revocation stops the view. A lost
 * connection is retried with backoff and, when the retries run out, shows
 * offline instead of the last good status.
 */
export class FactoryRunStream {
	private readonly controller = new AbortController();
	private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly maxReconnects: number;
	private readonly backoffMs: (attempt: number) => number;
	private status: FactoryRunStreamStatus = { state: "connecting", applied: 0, duplicates: 0, gaps: 0, reconnects: 0, lag: 0 };
	private token = "";
	private failures = 0;

	constructor(private readonly options: FactoryRunStreamOptions) {
		this.sleep = options.sleep ?? defaultSleep;
		this.maxReconnects = options.maxReconnects ?? 5;
		this.backoffMs = options.backoffMs ?? (attempt => Math.min(30_000, 500 * 2 ** attempt));
	}

	get current(): FactoryRunStreamStatus { return this.status; }

	stop(): void { this.controller.abort(); }

	/** Runs until the stream ends, is revoked, goes offline, or `stop()` is called. */
	async run(): Promise<FactoryRunStreamStatus> {
		let outcome: Outcome = "snapshot";
		while (!this.controller.signal.aborted) {
			switch (outcome) {
				case "stop":
					return this.status;
				case "snapshot":
					outcome = await this.takeSnapshot();
					break;
				case "reopen":
					outcome = await this.follow();
					break;
				case "backoff":
					this.failures += 1;
					if (this.failures > this.maxReconnects) { this.update({ state: "offline", reason: "reconnect-limit" }); return this.status; }
					this.update({ state: "reconnecting", reconnects: this.status.reconnects + 1 });
					await this.sleep(this.backoffMs(this.failures - 1), this.controller.signal);
					outcome = this.token === "" ? "snapshot" : "reopen";
					break;
				default:
					// Every outcome is handled above; anything else is a defect, never a silent spin.
					throw new Error(`factory run stream: unknown outcome ${String(outcome satisfies never)}`);
			}
		}
		return this.status;
	}

	private update(change: Partial<FactoryRunStreamStatus>): void {
		this.status = { ...this.status, ...change };
		this.options.onStatus(this.status);
	}

	private async takeSnapshot(): Promise<Outcome> {
		this.update({ state: "connecting" });
		try {
			const inspection = await this.options.snapshot();
			this.token = inspection.cursor.token;
			this.update({ applied: inspection.cursor.sequence, lag: inspection.projectionLag });
			this.options.onSnapshot(inspection);
			return "reopen";
		} catch (error) {
			return statusCode(error) === 403 ? this.revoke("snapshot-refused") : "backoff";
		}
	}

	private revoke(reason: string): Outcome {
		this.update({ state: "revoked", reason });
		return "stop";
	}

	private async refresh(): Promise<void> {
		try {
			const inspection = await this.options.snapshot();
			this.update({ lag: inspection.projectionLag });
			this.options.onSnapshot(inspection);
		} catch (error) {
			if (statusCode(error) === 403) this.revoke("snapshot-refused");
		}
	}

	private async follow(): Promise<Outcome> {
		const local = new AbortController();
		const combined = AbortSignal.any([this.controller.signal, local.signal]);
		let body: ReadableStream<Uint8Array>;
		try {
			body = await this.options.open(this.token, combined);
		} catch (error) {
			const code = statusCode(error);
			if (code === 410) return "snapshot";
			if (code === 403) return this.revoke("stream-refused");
			return "backoff";
		}
		this.failures = 0;
		this.update({ state: this.status.lag > 0 ? "lagging" : "live" });
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let appliedSinceSnapshot = false;
		try {
			for (;;) {
				const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const parsed = parseSseFrames(buffer);
				buffer = parsed.rest;
				for (const frame of parsed.frames) {
					const verdict = await this.apply(frame, appliedSinceSnapshot);
					if (verdict === "applied") appliedSinceSnapshot = true;
					else if (verdict === "refreshed") appliedSinceSnapshot = false;
					else if (verdict !== "continue") return verdict;
				}
			}
		} finally {
			local.abort();
			reader.releaseLock();
		}
		return this.controller.signal.aborted ? "stop" : "backoff";
	}

	private async apply(frame: FactorySseFrame, appliedSinceSnapshot: boolean): Promise<Outcome | "continue" | "applied" | "refreshed"> {
		if (frame.event === RUN_EVENT) {
			const event = JSON.parse(frame.data) as FactoryRunEvent;
			if (event.sequence <= this.status.applied) { this.update({ duplicates: this.status.duplicates + 1 }); return "continue"; }
			if (event.sequence > this.status.applied + 1) {
				this.update({ state: "catching-up", gaps: this.status.gaps + 1 });
				return "reopen";
			}
			this.update({ applied: event.sequence });
			if (frame.id !== undefined) this.token = frame.id;
			this.options.onEvent?.(event);
			return "applied";
		}
		if (frame.event === RUN_STATUS) {
			const status = JSON.parse(frame.data) as { status: string; sequence: number; drained: boolean };
			if (status.sequence > this.status.applied) {
				this.update({ state: "catching-up", gaps: this.status.gaps + 1 });
				return "reopen";
			}
			if (frame.id !== undefined && status.sequence === this.status.applied) this.token = frame.id;
			if (appliedSinceSnapshot || status.drained) {
				await this.refresh();
				if (this.status.state === "revoked") return "stop";
				this.update({ state: this.status.lag > 0 ? "lagging" : "live" });
				return "refreshed";
			}
			return "continue";
		}
		if (frame.event === STREAM_CLOSED) {
			const { reason } = JSON.parse(frame.data) as { reason: string };
			if (reason === "drained") { this.update({ state: "ended", reason }); return "stop"; }
			if (reason === "revoked" || reason === "not-found") return this.revoke(reason);
			if (reason === "expired") return "snapshot";
			if (reason === "deadline") { this.update({ state: "connecting" }); return "reopen"; }
			return "backoff";
		}
		return "continue";
	}
}
