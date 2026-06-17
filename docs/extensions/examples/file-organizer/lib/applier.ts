// ── applier.ts — pure op-planner ────────────────────────────────────
//
// Turns a single accepted `Proposal` into an ordered list of low-level
// filesystem OPS that the HOST applier executes with raw node:fs. This
// module performs NO real IO — it emits a plan so the host can run it
// under realpath/lstat guards + an intent journal. Keeping the decision
// logic pure makes every branch (no-overwrite, EXDEV, symlink skip,
// hardlink skip, case-insensitive no-op) unit-testable.

import { basename, join } from "node:path";
import type { Proposal } from "./proposals";
import { resolveNonOverwrite } from "./quarantine";

/** A single filesystem operation in an apply plan. */
export type ApplyOp =
  | { op: "mkdirp"; path: string }
  | { op: "copy"; src: string; dst: string }
  | { op: "verify"; path: string; expectedSize: number }
  | { op: "unlink"; path: string }
  | { op: "quarantine"; src: string; quarantineId: string };

export interface ApplyPlan {
  proposalId: string;
  ops: ApplyOp[];
  /** Final resolved destination (for move/rename), or null for quarantine. */
  resolvedDst: string | null;
}

export type PlanResult =
  | { ok: true; plan: ApplyPlan }
  | { ok: false; reason: string; skip?: boolean };

/** Environment facts the planner needs (injected — no IO in this module). */
export interface PlanEnv {
  /** Does a path currently exist? (host-mediated; injected) */
  exists: (p: string) => boolean;
  /** Is the host filesystem case-insensitive? Affects same-file detection. */
  caseInsensitive?: boolean;
  /** Fresh quarantine id generator (for delete-quarantine proposals). */
  quarantineIdGen?: () => string;
}

/** Normalize a path for case-insensitive same-file comparison. */
function sameFile(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Plan the ops for one accepted proposal. Returns `{ ok:false, skip:true }`
 * for benign no-ops (symlink, hardlink-dedup, case-insensitive same-file)
 * and `{ ok:false }` (non-skip) for hard errors (missing dst on a move).
 */
export function planApply(proposal: Proposal, env: PlanEnv): PlanResult {
  // Symlinks are never followed/applied in v1 — record-only.
  if (proposal.snapshot.isSymlink) {
    return { ok: false, reason: "symlink skipped (v1 policy)", skip: true };
  }

  switch (proposal.kind) {
    case "move":
    case "rename": {
      if (!proposal.dst) return { ok: false, reason: "move/rename requires a destination" };

      // Case-insensitive same-file no-op (e.g. `foo.TXT` → `foo.txt` on
      // a case-insensitive FS resolves to the same inode).
      if (sameFile(proposal.src, proposal.dst, env.caseInsensitive ?? false)) {
        return { ok: false, reason: "source and destination are the same file", skip: true };
      }

      // Hardlink dedup-delete is excluded; a plain move of a hardlinked
      // file is still fine (we move the link). nlink only blocks
      // dedup-delete, handled in rules; here moves proceed.

      // Never overwrite: resolve a collision-free destination.
      const resolvedDst = resolveNonOverwrite(proposal.dst, env.exists);
      const destDir = resolvedDst.slice(0, resolvedDst.length - basename(resolvedDst).length).replace(/\/+$/, "") || "/";

      const ops: ApplyOp[] = [
        { op: "mkdirp", path: destDir },
        // EXDEV-safe by construction: copy then verify then unlink the
        // original (the host falls back to copy+unlink across devices;
        // a same-device move is still a copy+unlink here for one code
        // path + crash-journal symmetry).
        { op: "copy", src: proposal.src, dst: resolvedDst },
        { op: "verify", path: resolvedDst, expectedSize: proposal.snapshot.size },
        { op: "unlink", path: proposal.src },
      ];
      return { ok: true, plan: { proposalId: proposal.id, ops, resolvedDst } };
    }

    case "delete-quarantine": {
      const quarantineId = proposal.quarantineId ?? env.quarantineIdGen?.() ?? proposal.id;
      const ops: ApplyOp[] = [{ op: "quarantine", src: proposal.src, quarantineId }];
      return { ok: true, plan: { proposalId: proposal.id, ops, resolvedDst: null } };
    }

    case "unclassified":
      // Unclassified is an ALERT, not an applyable action — the user must
      // pick a destination or teach a rule first.
      return { ok: false, reason: "unclassified proposals are not directly applyable" };

    default:
      return { ok: false, reason: `unknown proposal kind: ${(proposal as Proposal).kind}` };
  }
}

/**
 * Compute the routed destination path for a file matched by a `route`
 * rule: `<watchedRoot>/<dest>/<basename>`. Pure helper used by the daemon
 * to build move proposals from routing rules.
 */
export function routeDestination(watchedRoot: string, dest: string, srcPath: string): string {
  return join(watchedRoot, dest, basename(srcPath));
}
