// ── proposals.ts — the proposal queue: types, dedupe, state machine ──
//
// Pure logic only. IO is INJECTED (`ProposalsIO`) so this module is
// unit-testable without a filesystem and importable by BOTH the
// sandboxed subprocess (host-mediated fs) and the host daemon/applier
// (raw node:fs). No `node:fs` at module top.
//
// A `Proposal` is one pending file-organization change the daemon
// generated or an agent proposed. The user accepts/rejects it from the
// Hub `review` page; the host applier executes accepted ones.

/** A file-organization action kind. */
export type ProposalKind = "move" | "rename" | "delete-quarantine" | "unclassified";

/**
 * Proposal lifecycle. `pending` → terminal (`applied`/`rejected`/`failed`)
 * or `stale-source` (source vanished before apply) / `blocked`
 * (engine.authorize denied at apply time).
 */
export type ProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "failed"
  | "stale-source"
  | "blocked";

/** Filesystem snapshot captured when the proposal was generated. Used
 *  for stability gating, dedup, and stale-source detection at apply. */
export interface ProposalSnapshot {
  size: number;
  mtimeMs: number;
  sha256?: string;
  isSymlink: boolean;
  dev: number;
  ino: number;
  nlink: number;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  src: string;
  /** Destination for move/rename; null for delete-quarantine/unclassified. */
  dst: string | null;
  reason: string;
  ruleId: string | null;
  ruleLabel: string | null;
  folderId: string;
  snapshot: ProposalSnapshot;
  status: ProposalStatus;
  /** Stable key for dedup + suppressed-set membership. */
  dedupeKey: string;
  createdAt: string;
  /** Daemon batch this proposal was auto-applied as part of (fully-auto). */
  batchId?: string;
  /** Optimistic-concurrency version, bumped on every status transition. */
  version: number;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Quarantine entry id once a delete-quarantine is applied. */
  quarantineId?: string;
}

/** A rejected proposal remembered so the same file isn't re-nagged until
 *  TTL elapses or the file's content changes. Keyed by
 *  `(path, ruleId, contentHash)`. */
export interface SuppressedEntry {
  key: string;
  suppressedAt: string;
  /** Content hash at rejection time — a content change re-enables proposals. */
  contentHash: string | null;
}

/** On-disk shape of `proposals.json`. */
export interface ProposalsFile {
  proposals: Proposal[];
  suppressed: SuppressedEntry[];
  schemaVersion: number;
}

export const PROPOSALS_SCHEMA_VERSION = 1;

/** Empty queue — also the recover-to-empty target for a corrupt file. */
export function emptyProposalsFile(): ProposalsFile {
  return { proposals: [], suppressed: [], schemaVersion: PROPOSALS_SCHEMA_VERSION };
}

// ── Dedupe keys ─────────────────────────────────────────────────────

/**
 * Compute a proposal's dedupe key. Two proposals with the same key are
 * "the same suggestion" — the daemon skips generating a duplicate while
 * one is pending or already applied.
 *
 * Shape: `<kind>|<src>|<ruleId|"">|<dst|"">`. Stable across ticks for
 * the same file+rule+target.
 */
export function dedupeKey(input: {
  kind: ProposalKind;
  src: string;
  dst: string | null;
  ruleId: string | null;
}): string {
  return [input.kind, input.src, input.ruleId ?? "", input.dst ?? ""].join("|");
}

/**
 * Suppressed-set key for a rejected proposal. Keyed by
 * `(path, ruleId, contentHash)` so a re-saved file (new hash) escapes
 * suppression and can be re-proposed. `contentHash` may be null when the
 * file was never hashed (large/lazy) — then path+ruleId alone suppress.
 */
export function suppressedKey(input: {
  src: string;
  ruleId: string | null;
  contentHash: string | null;
}): string {
  return [input.src, input.ruleId ?? "", input.contentHash ?? ""].join("|");
}

// ── State machine ───────────────────────────────────────────────────

/** Legal status transitions. `pending` is the only non-terminal start. */
const LEGAL_TRANSITIONS: Record<ProposalStatus, ReadonlySet<ProposalStatus>> = {
  pending: new Set<ProposalStatus>([
    "applied",
    "rejected",
    "failed",
    "stale-source",
    "blocked",
  ]),
  // `failed`/`blocked`/`stale-source` are retryable back to pending (the
  // user can re-queue via "retry-failed"); terminal-positive states are not.
  failed: new Set<ProposalStatus>(["pending", "applied", "stale-source", "blocked"]),
  blocked: new Set<ProposalStatus>(["pending", "applied", "failed"]),
  "stale-source": new Set<ProposalStatus>(["rejected"]),
  applied: new Set<ProposalStatus>([]),
  rejected: new Set<ProposalStatus>([]),
};

/** Is `to` a legal next status from `from`? */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (from === to) return false;
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Apply a status transition to a proposal, bumping `version` and stamping
 * `resolvedAt`/`resolvedBy` on terminal states. Returns a NEW proposal
 * object (pure) or `null` when the transition is illegal.
 *
 * `expectedVersion`, when provided, enforces optimistic concurrency (CAS):
 * a stale caller (version mismatch) gets `null` — the apply is a no-op.
 */
export function transition(
  p: Proposal,
  to: ProposalStatus,
  opts?: { by?: string; at?: string; expectedVersion?: number; quarantineId?: string; batchId?: string },
): Proposal | null {
  if (opts?.expectedVersion !== undefined && opts.expectedVersion !== p.version) {
    return null; // CAS failure — someone else already moved it.
  }
  if (!canTransition(p.status, to)) return null;
  const isTerminal = to === "applied" || to === "rejected";
  return {
    ...p,
    status: to,
    version: p.version + 1,
    ...(isTerminal
      ? { resolvedAt: opts?.at ?? new Date().toISOString(), resolvedBy: opts?.by ?? "system" }
      : {}),
    ...(opts?.quarantineId !== undefined ? { quarantineId: opts.quarantineId } : {}),
    ...(opts?.batchId !== undefined ? { batchId: opts.batchId } : {}),
  };
}

// ── Suppressed-set (TTL) ────────────────────────────────────────────

/** Default suppressed-set TTL: 14 days. After this a rejected file may be
 *  re-proposed even without a content change. */
export const SUPPRESSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Is a candidate (path+ruleId+hash) currently suppressed? A suppressed
 * entry expires after `ttlMs`; a content-hash mismatch (file changed)
 * also lifts suppression.
 */
export function isSuppressed(
  suppressed: SuppressedEntry[],
  candidate: { src: string; ruleId: string | null; contentHash: string | null },
  now: number,
  ttlMs: number = SUPPRESSED_TTL_MS,
): boolean {
  const key = suppressedKey(candidate);
  for (const e of suppressed) {
    if (e.key !== key) continue;
    if (now - new Date(e.suppressedAt).getTime() >= ttlMs) return false; // expired
    // A content change (different hash) lifts suppression. If either side
    // is null we fall back to path+ruleId suppression (the key matched).
    if (e.contentHash !== null && candidate.contentHash !== null && e.contentHash !== candidate.contentHash) {
      return false;
    }
    return true;
  }
  return false;
}

/** Add (or refresh) a suppressed entry. Returns a NEW array (pure). */
export function addSuppressed(
  suppressed: SuppressedEntry[],
  candidate: { src: string; ruleId: string | null; contentHash: string | null },
  at: string,
): SuppressedEntry[] {
  const key = suppressedKey(candidate);
  const without = suppressed.filter((e) => e.key !== key);
  return [...without, { key, suppressedAt: at, contentHash: candidate.contentHash }];
}

/** Drop expired suppressed entries (housekeeping). Pure. */
export function pruneSuppressed(
  suppressed: SuppressedEntry[],
  now: number,
  ttlMs: number = SUPPRESSED_TTL_MS,
): SuppressedEntry[] {
  return suppressed.filter((e) => now - new Date(e.suppressedAt).getTime() < ttlMs);
}

// ── Dedup decision ──────────────────────────────────────────────────

/**
 * Should the daemon SKIP generating a candidate proposal? Skip when an
 * equivalent proposal is already pending/applied, OR when the candidate
 * is in the (non-expired, content-matched) suppressed-set.
 */
export function shouldSkipCandidate(
  file: ProposalsFile,
  candidate: { kind: ProposalKind; src: string; dst: string | null; ruleId: string | null; contentHash: string | null },
  now: number,
  ttlMs: number = SUPPRESSED_TTL_MS,
): boolean {
  const key = dedupeKey(candidate);
  for (const p of file.proposals) {
    if (p.dedupeKey === key && (p.status === "pending" || p.status === "applied")) {
      return true;
    }
  }
  return isSuppressed(file.suppressed, candidate, now, ttlMs);
}

// ── Injectable IO ───────────────────────────────────────────────────

/**
 * Injected IO surface for atomic load/save of `proposals.json`. The host
 * applier/daemon implement this with raw `node:fs` (temp+rename under a
 * `.lock`); the subprocess implements it with the host-mediated SDK fs
 * helpers. Tests pass an in-memory fake.
 */
export interface ProposalsIO {
  /** Read the raw JSON text, or null when the file is absent. */
  read(): Promise<string | null>;
  /** Atomically replace the file contents (temp+rename under .lock). */
  write(text: string): Promise<void>;
}

/**
 * Load `proposals.json` via injected IO. A corrupt/unparseable file
 * recovers to an EMPTY queue (the caller is expected to sidecar the
 * corrupt original separately). Missing file → empty.
 */
export async function loadProposals(io: ProposalsIO): Promise<{ file: ProposalsFile; corrupt: boolean }> {
  const text = await io.read();
  if (text === null) return { file: emptyProposalsFile(), corrupt: false };
  try {
    const parsed = JSON.parse(text) as Partial<ProposalsFile>;
    if (!parsed || !Array.isArray(parsed.proposals) || !Array.isArray(parsed.suppressed)) {
      return { file: emptyProposalsFile(), corrupt: true };
    }
    return {
      file: {
        proposals: parsed.proposals,
        suppressed: parsed.suppressed,
        schemaVersion: parsed.schemaVersion ?? PROPOSALS_SCHEMA_VERSION,
      },
      corrupt: false,
    };
  } catch {
    return { file: emptyProposalsFile(), corrupt: true };
  }
}

/** Persist `proposals.json` via injected IO (atomic, 2-space JSON). */
export async function saveProposals(io: ProposalsIO, file: ProposalsFile): Promise<void> {
  await io.write(JSON.stringify(file, null, 2));
}

/** Find a proposal by id. Returns undefined when absent. */
export function findProposal(file: ProposalsFile, id: string): Proposal | undefined {
  return file.proposals.find((p) => p.id === id);
}

/** Replace a proposal in-place by id, returning a NEW file (pure). */
export function replaceProposal(file: ProposalsFile, updated: Proposal): ProposalsFile {
  return {
    ...file,
    proposals: file.proposals.map((p) => (p.id === updated.id ? updated : p)),
  };
}
