/**
 * agent-fuzzy-search-bridge — main-thread façade over the agent-fuzzy
 * Web Worker (Phase 49.2).
 *
 * Owns:
 *   - Lazy worker instantiation (singleton — first `rankAgents()` call
 *     spawns the Worker; subsequent calls reuse it).
 *   - Threshold gate: lists ≤100 candidates run synchronously on the
 *     main thread (cheaper than a postMessage round-trip for small
 *     lists; see `WORKER_THRESHOLD` below). 101+ go to the worker.
 *   - Request / response correlation by id so concurrent calls don't
 *     collide.
 *
 * Test hooks mirror `kokoro-tts-bridge` exactly:
 *   `setWorkerFactoryForTests(factory)` injects a stub Worker, and
 *   `shutdownWorker()` tears state down between tests.
 */

import { rank, type RankRequest, type RankResponse } from "./agent-fuzzy-search-worker";

/**
 * Below this candidate count the bridge stays on the main thread —
 * the postMessage round-trip costs ~1-5ms by itself, which dwarfs
 * fuzzy-scoring 50-100 strings. Raise this if benchmarks show the
 * worker is faster sooner; lower it if the main thread starts to
 * stutter on lists in the 80-100 range.
 *
 * Picked at 100 per Phase 49 spec § "Open questions" (a defensive
 * guess until benchmarked on real workloads). The threshold lives in
 * one place so a future tweak is a single-line change.
 */
export const WORKER_THRESHOLD = 100;

export interface AgentLike {
  name: string;
  description?: string | null;
}

export interface WorkerLike {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (ev: MessageEvent | ErrorEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (ev: MessageEvent | ErrorEvent) => void,
  ) => void;
  terminate: () => void;
}

type WorkerFactory = () => WorkerLike;

let workerInstance: WorkerLike | null = null;
let messageListener: ((ev: MessageEvent | ErrorEvent) => void) | null = null;
const pending = new Map<string, {
  resolve: (res: RankResponse) => void;
  reject: (err: Error) => void;
}>();

let workerFactory: WorkerFactory = defaultWorkerFactory;

function defaultWorkerFactory(): WorkerLike {
  // Vite-canonical module-worker spawn — the bundler picks up
  // `agent-fuzzy-search-worker.ts` at build time and ships it as a
  // separate chunk with `type: "module"` so its top-level imports
  // (including `fuzzy-match.ts`) resolve.
  const w = new Worker(
    new URL("./agent-fuzzy-search-worker.ts", import.meta.url),
    { type: "module" },
  );
  return w as unknown as WorkerLike;
}

function ensureWorker(): WorkerLike {
  if (workerInstance) return workerInstance;
  const w = workerFactory();
  messageListener = (ev: MessageEvent | ErrorEvent) => {
    if ("error" in ev || ev.type === "error" || ev.type === "messageerror") {
      const errEv = ev as ErrorEvent;
      const message = errEv.message ?? "agent-fuzzy worker crashed";
      for (const [, slot] of pending) slot.reject(new Error(message));
      pending.clear();
      return;
    }
    const msg = (ev as MessageEvent).data as RankResponse | undefined;
    if (!msg || msg.type !== "ranked") return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    slot.resolve(msg);
  };
  w.addEventListener("message", messageListener);
  w.addEventListener("error", messageListener);
  w.addEventListener("messageerror", messageListener);
  workerInstance = w;
  return w;
}

let nextId = 0;
function makeId(): string {
  nextId++;
  return `afs-${Date.now().toString(36)}-${nextId}`;
}

export interface RankResult {
  /** Original indices into `candidates`, ordered by descending score. */
  indices: number[];
  /** Whether the worker (vs. main-thread sync path) was invoked. */
  usedWorker: boolean;
}

/**
 * Rank `candidates` against `query`. An empty query short-circuits to
 * "everyone matches, original order" so callers don't need to special-
 * case the unfiltered state.
 */
export function rankAgents(
  query: string,
  candidates: ReadonlyArray<AgentLike>,
): Promise<RankResult> {
  if (!query.trim()) {
    return Promise.resolve({
      indices: candidates.map((_, i) => i),
      usedWorker: false,
    });
  }

  if (candidates.length <= WORKER_THRESHOLD) {
    // Synchronous main-thread path — same scoring logic as the worker
    // for parity, just without the round-trip.
    const id = makeId();
    const reply = rank({ type: "rank", id, query, candidates: [...candidates] });
    return Promise.resolve({ indices: reply.indices, usedWorker: false });
  }

  const w = ensureWorker();
  const id = makeId();
  const promise = new Promise<RankResult>((resolve, reject) => {
    pending.set(id, {
      resolve: (res) => resolve({ indices: res.indices, usedWorker: true }),
      reject,
    });
  });
  const req: RankRequest = {
    type: "rank",
    id,
    query,
    candidates: candidates.map((c) => ({
      name: c.name,
      description: c.description ?? null,
    })),
  };
  w.postMessage(req);
  return promise;
}

export function shutdownWorker(): void {
  if (workerInstance) {
    if (messageListener) {
      workerInstance.removeEventListener("message", messageListener);
      workerInstance.removeEventListener("error", messageListener);
      workerInstance.removeEventListener("messageerror", messageListener);
    }
    workerInstance.terminate();
    workerInstance = null;
    messageListener = null;
  }
  for (const [, slot] of pending) slot.reject(new Error("worker shut down"));
  pending.clear();
}

export function setWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactory = factory ?? defaultWorkerFactory;
  shutdownWorker();
}
