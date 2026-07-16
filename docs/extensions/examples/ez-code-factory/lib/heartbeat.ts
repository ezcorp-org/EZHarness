// ── Reconcile-sweep heartbeat KV (M6) ────────────────────────────────
//
// The background sweep records a heartbeat (last run + counts) in global
// Storage; `code_factory_doctor` reads it for the "loop healthy?" check. A tiny
// KV over an injectable storage-like so the read/write paths are unit-tested
// with a fake (no live channel) — and so the await-return bodies don't get
// orphaned by bun's object-literal coverage attribution inside index.ts.

import { Storage } from "@ezcorp/sdk/runtime";
import { SWEEP_HEARTBEAT_KEY, type SweepHeartbeat } from "./sweep";

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
