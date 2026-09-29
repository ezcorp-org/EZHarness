/**
 * Durable tombstones for workers this host never saw (W02d R8 and R6's release; coordinator ruling 2026-09-29 (A)).
 *
 * A stop can name a worker this host never ran: a dispatch the product refused after admission (R8), or an attempt
 * whose lease was reclaimed before it launched (R6). The runtime shows no container for it, but "no container now"
 * alone proves nothing about a launch still on its way. So the host writes a TOMBSTONE for that worker, durably and
 * BEFORE the stop is signed, and from then on refuses any launch or attach naming it (`worker_stopped`). "No process
 * now, none starting, none ever" is then true: the runtime answers for now, the per-worker start serialization for
 * starting, the tombstone for ever. The pool still releases only on the signed stop (C03).
 *
 * The file sits beside the host signing key (the supervisor's private state). Each entry is signed with the host
 * key over its canonical JSON, the same scheme as the physical-stop receipt, so an entry this host did not write, one
 * written for another host, or one for another tenant is refused rather than honoured. A failed write issues no
 * signature: the stop stays unconfirmed rather than claiming what the host cannot keep.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { loadFactoryHostSigningKey, type FactoryHostSigningKeySource } from "./host-stop-service";

export const FACTORY_HOST_TOMBSTONES_FILE = "host-worker-tombstones.jsonl";
/**
 * How long a tombstone is honoured. A launch for a stopped worker can only come from a product-side attempt that is
 * still open, and no attempt outlives its run's deadline plus the product's stop settlement; thirty days is far past
 * any run deadline this platform allows, and an entry is a few hundred bytes (the gates file states the reasoning).
 */
export const FACTORY_HOST_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SCHEMA = "factory.host-worker-tombstone.v1";
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface FactoryHostTombstoneInput {
  readonly tenantId: string;
  readonly workerId: string;
  readonly attemptId: string;
  readonly reservationId: string;
}

interface TombstoneEntry extends FactoryHostTombstoneInput {
  readonly schemaVersion: typeof SCHEMA;
  readonly hostId: string;
  readonly recordedAtMs: number;
  readonly expiresAtMs: number;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20);
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const scopeKey = (tenantId: string, workerId: string) => `${tenantId}\u0000${workerId}`;

function entryOf(value: FactoryHostTombstoneInput & { hostId: string; recordedAtMs: number; expiresAtMs: number }): TombstoneEntry {
  return { schemaVersion: SCHEMA, hostId: value.hostId, tenantId: value.tenantId, workerId: value.workerId, attemptId: value.attemptId, reservationId: value.reservationId, recordedAtMs: value.recordedAtMs, expiresAtMs: value.expiresAtMs };
}

export class FactoryHostTombstones {
  private readonly honoured = new Map<string, TombstoneEntry>();
  private readonly pending = new Set<string>();
  private refusedCount = 0;

  private constructor(
    private readonly hostId: string,
    private readonly path: string,
    private readonly key: { readonly hostKeyId: string; readonly privateKey: KeyObject; readonly publicKey: KeyObject },
    private readonly now: () => number,
    private readonly retentionMs: number,
  ) {}

  /** Opens the host's tombstones, honouring only unexpired entries this host signed for itself. */
  static async open(source: FactoryHostSigningKeySource, now: () => number = Date.now, retentionMs = FACTORY_HOST_TOMBSTONE_RETENTION_MS): Promise<FactoryHostTombstones> {
    const signing = await loadFactoryHostSigningKey(source);
    const store = new FactoryHostTombstones(source.hostId, join(dirname(source.privateKeyPath), FACTORY_HOST_TOMBSTONES_FILE),
      { ...signing, publicKey: createPublicKey(signing.privateKey) }, now, retentionMs);
    await store.load();
    return store;
  }

  /** Lines refused at load: not this host's signature, another host, malformed, or expired. */
  get refused(): number { return this.refusedCount; }

  /** Whether a launch or attach of this worker, for this tenant, must be refused. */
  stopped(tenantId: string, workerId: string): boolean {
    const key = scopeKey(tenantId, workerId);
    if (this.pending.has(key)) return true;
    const entry = this.honoured.get(key);
    return entry !== undefined && entry.expiresAtMs > this.now();
  }

  /**
   * Refuses launches of this worker from now on, before anything is awaited, so a launch cannot slip in while the
   * stop inspects the runtime and writes the tombstone. The returned release lifts a reservation that was not
   * recorded; after `record` the tombstone itself keeps refusing.
   */
  reserve(tenantId: string, workerId: string): () => void {
    const key = scopeKey(tenantId, workerId);
    this.pending.add(key);
    return () => { this.pending.delete(key); };
  }

  /** Writes the signed tombstone durably (appended and synced) before any stop is signed; a failed write throws. */
  async record(input: FactoryHostTombstoneInput): Promise<void> {
    if (!text(input.tenantId) || !text(input.workerId) || !text(input.attemptId) || !text(input.reservationId)) throw new Error("Factory host tombstone is malformed.");
    const recordedAtMs = this.now();
    const entry = entryOf({ ...input, hostId: this.hostId, recordedAtMs, expiresAtMs: recordedAtMs + this.retentionMs });
    const signature = sign("RSA-SHA256", Buffer.from(canonicalJson(entry)), this.key.privateKey).toString("base64url");
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify({ ...entry, hostKeyId: this.key.hostKeyId, signature })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    this.honoured.set(scopeKey(entry.tenantId, entry.workerId), entry);
  }

  private async load(): Promise<void> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (content.length > MAX_FILE_BYTES) throw new Error("Factory host tombstones are oversized.");
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const entry = this.verified(line);
      if (entry) this.honoured.set(scopeKey(entry.tenantId, entry.workerId), entry);
      else this.refusedCount += 1;
    }
  }

  private verified(line: string): TombstoneEntry | undefined {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { return undefined; }
    if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA || value.hostId !== this.hostId || !text(value.tenantId) || !text(value.workerId)
      || !text(value.attemptId) || !text(value.reservationId) || !counter(value.recordedAtMs) || !counter(value.expiresAtMs) || typeof value.signature !== "string") return undefined;
    const entry = entryOf(value as unknown as TombstoneEntry);
    let valid = false;
    try { valid = verify("RSA-SHA256", Buffer.from(canonicalJson(entry)), this.key.publicKey, Buffer.from(value.signature, "base64url")); }
    catch { valid = false; }
    return valid && entry.expiresAtMs > this.now() ? entry : undefined;
  }
}
