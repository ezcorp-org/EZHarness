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
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { FACTORY_LIMITS } from "@ezcorp/factory-sdk";
import type { FactoryJournalHostKey } from "../journal-validation";
import { factoryStopHostKeyMap, type FactoryStopHostKey } from "../stop-host-keys";
import { loadFactoryHostSigningKey, type FactoryHostSigningKeySource } from "./host-stop-service";

export const FACTORY_HOST_TOMBSTONES_FILE = "host-worker-tombstones.jsonl";
/** The margin a tombstone keeps past the longest run deadline: clock skew between product and host, and the stop's settlement. */
export const FACTORY_HOST_TOMBSTONE_GRACE_MS = 24 * 60 * 60 * 1_000;
/**
 * How long a tombstone is honoured. A launch naming a stopped worker comes only from an attempt of that worker's run,
 * and the kernel caps every run's deadline at FACTORY_LIMITS.maximumRunDeadlineMs (30 days) from its start. A
 * tombstone is written after its run started, so that span from the write plus the grace outlives every deadline that
 * run's attempts can carry. The host does not
 * refuse a launch whose deadline has passed, so the tombstone itself must cover the whole span. The test holds this
 * against the kernel's own cap. An entry is a few hundred bytes; the gates file states the reasoning.
 */
export const FACTORY_HOST_TOMBSTONE_RETENTION_MS = FACTORY_LIMITS.maximumRunDeadlineMs + FACTORY_HOST_TOMBSTONE_GRACE_MS;
const SCHEMA = "factory.host-worker-tombstone.v1";
/**
 * The file's bound. Compaction keeps only the live window in it, so the bound counts tombstones recorded within one
 * retention span, not over the host's life: at a few hundred bytes each, tens of thousands per 31 days.
 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Makes a folder's entries durable: fsync of the folder itself. */
async function syncFolder(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export interface FactoryHostTombstonesOptions {
  readonly now?: () => number;
  readonly retentionMs?: number;
  /**
   * The host's retired public keys still trusted (the retained trust policy, the same set the product's stop verifier
   * keeps). The current key is always trusted. What a retained key signed still verifies after a rotation.
   */
  readonly retainedKeys?: readonly FactoryStopHostKey[];
  /** The file's bound in bytes (tests shrink it). */
  readonly maxFileBytes?: number;
  /** Syncs the folder that holds the file; the production one fsyncs it. */
  readonly syncDirectory?: (path: string) => Promise<void>;
}

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
  /** Each honoured tombstone with its signed line, as the file holds it. */
  private readonly honoured = new Map<string, { readonly entry: TombstoneEntry; readonly line: string }>();
  /** The file's size in bytes. */
  private bytes = 0;
  private readonly pending = new Set<string>();
  private refusedCount = 0;
  /**
   * Live entries for this host that no trusted key verifies (validator-6 D6, coordinator ruling (a)+(c)). One cannot
   * be told from a genuine tombstone whose key was rotated away, so while any is inside its window the host refuses
   * every launch, compaction keeps it for the operator, and it lapses only when its own window ends.
   */
  private readonly poison: { readonly expiresAtMs: number; readonly line: string }[] = [];
  /** Whether the file exists: the write that creates it must also make the folder entry durable. */
  private exists = false;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxFileBytes: number;
  private readonly syncDirectory: (path: string) => Promise<void>;

  private constructor(
    private readonly hostId: string,
    private readonly path: string,
    private readonly key: { readonly hostKeyId: string; readonly privateKey: KeyObject },
    private readonly trusted: ReadonlyMap<string, FactoryJournalHostKey>,
    options: FactoryHostTombstonesOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? FACTORY_HOST_TOMBSTONE_RETENTION_MS;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.syncDirectory = options.syncDirectory ?? syncFolder;
  }

  /** Opens the host's tombstones, honouring only unexpired entries this host signed for itself. */
  static async open(source: FactoryHostSigningKeySource, options: FactoryHostTombstonesOptions = {}): Promise<FactoryHostTombstones> {
    const signing = await loadFactoryHostSigningKey(source);
    const trusted = factoryStopHostKeyMap([{ hostId: source.hostId, hostKeyId: signing.hostKeyId, publicKey: createPublicKey(signing.privateKey) }, ...(options.retainedKeys ?? [])]);
    const store = new FactoryHostTombstones(source.hostId, join(dirname(source.privateKeyPath), FACTORY_HOST_TOMBSTONES_FILE), signing, trusted, options);
    await store.load();
    return store;
  }

  /** Lines dropped at load: malformed, another host's, or expired. */
  get refused(): number { return this.refusedCount; }

  /** Live entries no trusted key verifies; while any exists, every launch is refused. */
  get poisoned(): number {
    const now = this.now();
    return this.poison.filter((entry) => entry.expiresAtMs > now).length;
  }

  /** Whether a launch or attach of this worker, for this tenant, must be refused. */
  stopped(tenantId: string, workerId: string): boolean {
    const key = scopeKey(tenantId, workerId);
    if (this.pending.has(key) || this.poisoned > 0) return true;
    const entry = this.honoured.get(key)?.entry;
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

  /**
   * Writes the signed tombstone durably (appended and synced; the write that creates the file also syncs its folder,
   * so the first entry survives a crash) before any stop is signed. A write that would pass the file's bound first
   * drops the expired entries; a live window that is still full refuses the write. A failed write throws and honours
   * nothing.
   */
  async record(input: FactoryHostTombstoneInput): Promise<void> {
    if (!text(input.tenantId) || !text(input.workerId) || !text(input.attemptId) || !text(input.reservationId)) throw new Error("Factory host tombstone is malformed.");
    const recordedAtMs = this.now();
    const entry = entryOf({ ...input, hostId: this.hostId, recordedAtMs, expiresAtMs: recordedAtMs + this.retentionMs });
    const signature = sign("RSA-SHA256", Buffer.from(canonicalJson(entry)), this.key.privateKey).toString("base64url");
    const line = `${JSON.stringify({ ...entry, hostKeyId: this.key.hostKeyId, signature })}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxFileBytes) await this.compact();
    if (this.bytes + size > this.maxFileBytes) throw new Error("Factory host tombstones are full.");
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(line);
      await handle.sync();
    } finally { await handle.close(); }
    this.bytes += size;
    if (!this.exists) {
      await this.syncDirectory(dirname(this.path));
      this.exists = true;
    }
    this.honoured.set(scopeKey(entry.tenantId, entry.workerId), { entry, line });
  }

  /**
   * Rewrites the file with the unexpired entries only, the unverifiable live ones included: written aside, synced,
   * renamed over it, the folder synced.
   */
  private async compact(): Promise<void> {
    const now = this.now();
    for (const [key, { entry }] of this.honoured) if (entry.expiresAtMs <= now) this.honoured.delete(key);
    const poison = this.poison.splice(0).filter((entry) => entry.expiresAtMs > now);
    this.poison.push(...poison);
    const content = [...this.honoured.values(), ...poison].map(({ line }) => line).join("");
    const aside = `${this.path}.compact`;
    const handle = await open(aside, "w", 0o600);
    try {
      await handle.write(content);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(aside, this.path);
    await this.syncDirectory(dirname(this.path));
    this.exists = true;
    this.bytes = Buffer.byteLength(content);
  }

  private async load(): Promise<void> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.exists = true;
    this.bytes = Buffer.byteLength(content);
    if (this.bytes > this.maxFileBytes) throw new Error("Factory host tombstones are oversized.");
    let superseded = 0;
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const verdict = this.verified(line);
      if (!verdict) { this.refusedCount += 1; continue; }
      if (verdict.kind === "poison") { this.poison.push({ expiresAtMs: verdict.expiresAtMs, line: `${line}\n` }); continue; }
      const entry = verdict.entry;
      const key = scopeKey(entry.tenantId, entry.workerId);
      if (this.honoured.has(key)) superseded += 1;
      this.honoured.set(key, { entry, line: `${line}\n` });
    }
    if (this.refusedCount + superseded > 0) await this.compact();
  }

  /**
   * A line's verdict: dropped (undefined) when malformed, another host's, or expired; honoured when a trusted key of
   * this host verifies it; otherwise poison, a live entry this host cannot vouch for.
   */
  private verified(line: string): { readonly kind: "honoured"; readonly entry: TombstoneEntry } | { readonly kind: "poison"; readonly expiresAtMs: number } | undefined {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { return undefined; }
    if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA || value.hostId !== this.hostId || !text(value.tenantId) || !text(value.workerId)
      || !text(value.attemptId) || !text(value.reservationId) || !counter(value.recordedAtMs) || !counter(value.expiresAtMs) || !text(value.hostKeyId) || typeof value.signature !== "string") return undefined;
    const entry = entryOf(value as unknown as TombstoneEntry);
    if (entry.expiresAtMs <= this.now()) return undefined;
    const key = this.trusted.get(value.hostKeyId);
    let valid = false;
    try { valid = key?.hostId === this.hostId && verify("RSA-SHA256", Buffer.from(canonicalJson(entry)), key.publicKey, Buffer.from(value.signature, "base64url")); }
    catch { valid = false; }
    return valid ? { kind: "honoured", entry } : { kind: "poison", expiresAtMs: entry.expiresAtMs };
  }
}
