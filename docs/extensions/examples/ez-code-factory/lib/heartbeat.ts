// ── Reconcile-sweep heartbeat KV (M6) ────────────────────────────────
//
// The background sweep records a heartbeat (last run + counts) in global
// Storage; `code_factory_doctor` reads it for the "loop healthy?" check. A tiny
// KV over an injectable storage-like so the read/write paths are unit-tested
// with a fake (no live channel) — and so the await-return bodies don't get
// orphaned by bun's object-literal coverage attribution inside index.ts.

import { Storage } from "@ezcorp/sdk/runtime";
import { SWEEP_HEARTBEAT_KEY, type SweepHeartbeat } from "./sweep";
import type { RunRecord } from "./runs";

/** The two Storage ops the heartbeat needs (the SDK `Storage` matches
 *  structurally; a plain fake satisfies it in tests). */
export interface HeartbeatStorage {
  get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }>;
  set(key: string, value: unknown): Promise<void>;
}

/** Read/write the reconcile-sweep heartbeat. */
export interface HeartbeatKV {
  read(): Promise<SweepHeartbeat | null>;
  write(hb: SweepHeartbeat): Promise<void>;
}

/** Build a heartbeat KV over any storage-like. Pure over `storage`. */
export function makeHeartbeatKV(storage: HeartbeatStorage): HeartbeatKV {
  return {
    async read() {
      const r = await storage.get<SweepHeartbeat>(SWEEP_HEARTBEAT_KEY);
      return r.exists && r.value ? r.value : null;
    },
    async write(hb) {
      await storage.set(SWEEP_HEARTBEAT_KEY, hb);
    },
  };
}

/** Production heartbeat KV, backed by the global Storage bucket. The SDK
 *  `Storage` satisfies {@link HeartbeatStorage} structurally at runtime; the
 *  cast bridges its richer typed-get signature. */
export function productionHeartbeatKV(): HeartbeatKV {
  return makeHeartbeatKV(new Storage("global") as unknown as HeartbeatStorage);
}

// ── Per-run liveness heartbeat (the status-truthfulness fix, L3) ─────
//
// SEPARATE from the sweep heartbeat above (which tracks the sweep loop's own
// health). This tracks ONE RUN's liveness: the executor writes a fresh ISO
// timestamp under `heartbeats/<runId>` every 60 s while a step executes. It is a
// SEPARATE key, never a read-modify-write on `runs/<id>` — that would race
// supersedePriorRuns' abort. With 60 s beats a live process can never trip the
// stall threshold; a dead process trips it within ~10 min; a legacy run with no
// heartbeat key (frozen updatedAt) trips it immediately.

/** Storage key prefix for the per-run liveness heartbeat. */
export const RUN_HEARTBEAT_KEY_PREFIX = "heartbeats/";

/** Key holding one run's last-liveness ISO string. */
export function runHeartbeatKey(runId: string): string {
  return `${RUN_HEARTBEAT_KEY_PREFIX}${runId}`;
}

/** Heartbeat write cadence (well below STALL_AFTER_MS so a live run never trips). */
export const RUN_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Stall threshold — matches the dispatch patience (agent.ts DEFAULT_TIMEOUT_MS).
 *  A `running` run whose freshest liveness signal (max of updatedAt + heartbeat)
 *  is older than this is stalled. */
export const STALL_AFTER_MS = 10 * 60 * 1000;

/**
 * Staleness predicate (single shared helper — the sweep persists it, the page
 * loaders derive it). A run is stale iff it is `running` AND `now` is more than
 * STALL_AFTER_MS past the max of its `updatedAt` and its last heartbeat (0 when
 * absent). Unparseable timestamps degrade to 0 (never a throw), so a garbage
 * heartbeat can only make a run look older, never falsely fresh.
 */
export function isRunStale(
  run: Pick<RunRecord, "status" | "updatedAt">,
  heartbeatAt: string | null,
  nowMs: number,
): boolean {
  if (run.status !== "running") return false;
  const updated = Date.parse(run.updatedAt);
  const hb = heartbeatAt ? Date.parse(heartbeatAt) : 0;
  const u = Number.isNaN(updated) ? 0 : updated;
  const h = Number.isNaN(hb) ? 0 : hb;
  return nowMs - Math.max(u, h) > STALL_AFTER_MS;
}

/** Read/write one run's liveness heartbeat. */
export interface RunHeartbeatKV {
  read(runId: string): Promise<string | null>;
  write(runId: string, at: string): Promise<void>;
}

/** Build a per-run heartbeat KV over any storage-like. Pure over `storage`. */
export function makeRunHeartbeatKV(storage: HeartbeatStorage): RunHeartbeatKV {
  return {
    async read(runId) {
      const r = await storage.get<string>(runHeartbeatKey(runId));
      return r.exists && typeof r.value === "string" ? r.value : null;
    },
    async write(runId, at) {
      await storage.set(runHeartbeatKey(runId), at);
    },
  };
}

/** Production per-run heartbeat KV, backed by the global Storage bucket. */
export function productionRunHeartbeatKV(): RunHeartbeatKV {
  return makeRunHeartbeatKV(new Storage("global") as unknown as HeartbeatStorage);
}

/** Schedule a repeating callback; returns a stop fn. Injectable so the interval
 *  is driven deterministically in tests. */
export type HeartbeatSchedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: HeartbeatSchedule = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // Never keep the event loop alive on the heartbeat timer alone.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
};

/** Wiring for {@link withRunHeartbeat}. */
export interface RunHeartbeatConfig {
  /** Persist one liveness beat (ISO string under heartbeats/<runId>). */
  write: (runId: string, at: string) => Promise<void>;
  /** Injected clock (ms). */
  now: () => number;
  /** Interval scheduler (default: unref'd setInterval). */
  schedule?: HeartbeatSchedule;
  /** Beat cadence (default {@link RUN_HEARTBEAT_INTERVAL_MS}). */
  intervalMs?: number;
}

/**
 * Emit a per-run liveness heartbeat immediately and every `intervalMs` while
 * `fn` runs (the interval is cleared when `fn` settles). A heartbeat write
 * failure is SWALLOWED — liveness telemetry must never fail the run. Returns
 * `fn`'s result (or rethrows its rejection, after clearing the interval).
 */
export async function withRunHeartbeat<T>(
  cfg: RunHeartbeatConfig,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const beat = (): void => {
    // Capture the timestamp SYNCHRONOUSLY at beat time (not inside the deferred
    // write) so a beat reflects when it fired, not when the async write flushed.
    const at = new Date(cfg.now()).toISOString();
    void Promise.resolve()
      .then(() => cfg.write(runId, at))
      .catch(() => {
        /* liveness telemetry must never fail the run */
      });
  };
  beat(); // immediate — a run that dies before the first interval still recorded one
  const stop = (cfg.schedule ?? defaultSchedule)(beat, cfg.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    stop();
  }
}
