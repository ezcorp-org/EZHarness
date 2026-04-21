import type { MemoryStatus } from "./types";
import { getMemoriesForDecay, updateMemoryStatus } from "../db/queries/memories";
import { logger } from "../logger";
const log = logger.child("memory");

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ARCHIVE_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Compute the decay status based on how long since last access.
 */
export function computeStatus(lastAccessedAt: Date): MemoryStatus {
  const age = Date.now() - lastAccessedAt.getTime();
  if (age >= ARCHIVE_THRESHOLD_MS) return "archived";
  if (age >= STALE_THRESHOLD_MS) return "stale";
  return "active";
}

/**
 * Query memories eligible for decay and update their status.
 */
export async function runDecaySweep(): Promise<number> {
  const candidates = await getMemoriesForDecay();
  let updated = 0;

  for (const memory of candidates) {
    const lastAccessed = memory.lastAccessedAt instanceof Date
      ? memory.lastAccessedAt
      : new Date(memory.lastAccessedAt as string);
    const newStatus = computeStatus(lastAccessed);

    if (newStatus !== memory.status) {
      await updateMemoryStatus(memory.id, newStatus, "auto-decay");
      updated++;
    }
  }

  return updated;
}

/**
 * Start a recurring decay sweep. Returns a cleanup function to stop it.
 */
export function startDecayTimer(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    runDecaySweep().catch((err) => {
      log.error("Decay sweep error", { error: String(err) });
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
