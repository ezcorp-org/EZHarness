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
