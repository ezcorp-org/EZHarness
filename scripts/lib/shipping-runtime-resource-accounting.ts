import { posix } from "node:path";

export type FdClasses = { socket: number; pipe: number; anon: number; path: number; other: number };
export type OpenDescriptor = { fd: string; target: string; class: keyof FdClasses; device?: string; inode?: string };
export type RelationDescriptor = OpenDescriptor & { backingDevice?: string; backingInode?: string; backingMissing?: boolean };

export function fdClass(target: string): keyof FdClasses {
  if (target.startsWith("socket:")) return "socket";
  if (target.startsWith("pipe:")) return "pipe";
  if (target.startsWith("anon_inode:")) return "anon";
  if (target.startsWith("/")) return "path";
  return "other";
}

const RELATION_PATH = /^base\/[0-9]+\/[0-9]+(?:_(?:fsm|vm|init))?(?:\.[0-9]+)?$/;

/** PostgreSQL relation forks may have a numbered segment, such as `_fsm.1`. */
export function isPgliteRelationFile(target: string): boolean {
  return RELATION_PATH.test(target.replace(/ \(deleted\)$/, "").split("/").slice(-3).join("/"));
}

export function isPgliteRelationPath(dataRoot: string, target: string): boolean {
  if (target.endsWith(" (deleted)")) return false;
  const relative = posix.relative(dataRoot, target);
  return RELATION_PATH.test(relative);
}

export function nonRelationPathCount(snapshot: { classes: FdClasses; pgliteRelationDescriptors: RelationDescriptor[] }): number {
  return snapshot.classes.path - snapshot.pgliteRelationDescriptors.length;
}

export function nonRelationPathGrew(baseline: { classes: FdClasses; pgliteRelationDescriptors: RelationDescriptor[] }, observed: { classes: FdClasses; pgliteRelationDescriptors: RelationDescriptor[] }): boolean {
  return nonRelationPathCount(observed) > nonRelationPathCount(baseline);
}

export function relationDescriptorProblems(dataRoot: string, descriptors: RelationDescriptor[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const descriptor of descriptors) {
    if (!isPgliteRelationPath(dataRoot, descriptor.target)) problems.push(`PGlite relation descriptor ${descriptor.fd} escaped the data root: ${descriptor.target}`);
    if (descriptor.backingMissing || !descriptor.backingDevice || !descriptor.backingInode) problems.push(`PGlite relation descriptor ${descriptor.fd} has no live backing file: ${descriptor.target}`);
    else if (descriptor.device !== descriptor.backingDevice || descriptor.inode !== descriptor.backingInode) problems.push(`PGlite relation descriptor ${descriptor.fd} does not match its backing file: ${descriptor.target}`);
    const identity = `${descriptor.device ?? ""}:${descriptor.inode ?? ""}`;
    if (seen.has(identity)) problems.push(`PGlite relation descriptor ${descriptor.fd} duplicates an open backing inode: ${descriptor.target}`);
    seen.add(identity);
  }
  return problems;
}

/** Items of `after` without a match in `before` (added) and items of `before` left unmatched (removed), matched by `identity`. */
export function multisetDelta<T>(before: T[], after: T[], identity: (item: T) => string): { added: T[]; removed: T[] } {
  const remaining = new Map<string, T[]>();
  for (const item of before) {
    const key = identity(item);
    remaining.set(key, [...(remaining.get(key) ?? []), item]);
  }
  const added: T[] = [];
  for (const item of after) {
    const matches = remaining.get(identity(item));
    if (matches?.length) matches.pop();
    else added.push(item);
  }
  return { added, removed: [...remaining.values()].flat() };
}

export function openDescriptorIdentity(descriptor: OpenDescriptor): string {
  return `${descriptor.class}\u0000${descriptor.target}\u0000${descriptor.device ?? ""}\u0000${descriptor.inode ?? ""}`;
}

/** 150 polls 100 ms apart: at most about 15 s per cycle, the same bound as the app's post-cycle connection settle. */
export const RUNNER_FD_SETTLE_POLLS = 150;
export type RunnerFdSettle = { baseline: number; remaining: number; polls: number; maxPolls: number };

/**
 * Re-read the runner's descriptor count until it EQUALS the baseline, at most `maxPolls` reads.
 * The bound is a wait, never an allowance: a count above or below the baseline is returned as read,
 * and the caller's strict check then fails. A bound of 0 is one read with no wait (the strict check alone).
 */
export async function settleRunnerFds(read: () => Promise<number>, baseline: number, { maxPolls = RUNNER_FD_SETTLE_POLLS, pause = () => Bun.sleep(100) }: { maxPolls?: number; pause?: () => Promise<void> } = {}): Promise<RunnerFdSettle> {
  if (!Number.isInteger(maxPolls) || maxPolls < 0) throw new Error(`Runner FD settle needs a whole number of polls, not ${maxPolls}.`);
  const reads = Math.max(1, maxPolls);
  let polls = 0;
  let remaining = baseline;
  while (polls < reads) {
    polls++;
    remaining = await read();
    if (remaining === baseline) break;
    if (polls < reads) await pause();
  }
  return { baseline, remaining, polls, maxPolls };
}

/** Failure receipt for the runner FD check: every runner descriptor absent from the baseline snapshot, with its kind. */
export function runnerFdFailureEvidence(settle: RunnerFdSettle, baseline: OpenDescriptor[], observed: OpenDescriptor[]): { settle: RunnerFdSettle; extraDescriptors: OpenDescriptor[]; extraDescriptorKinds: FdClasses; missingDescriptors: OpenDescriptor[] } {
  const delta = multisetDelta(baseline, observed, openDescriptorIdentity);
  const extraDescriptorKinds: FdClasses = { socket: 0, pipe: 0, anon: 0, path: 0, other: 0 };
  for (const descriptor of delta.added) extraDescriptorKinds[descriptor.class]++;
  return { settle, extraDescriptors: delta.added, extraDescriptorKinds, missingDescriptors: delta.removed };
}
