// ── Push step — port of steps/push.go + steps/forcepush.go ──────────
//
// Commits leftover agent fixes and force-pushes the worktree state to the gate
// repo's upstream (`origin`), guarded by the patch-id force-push safety ported
// EXACTLY from internal/pipeline/steps/forcepush.go (spec §1 invariant 3):
//
//   - ls-remote the LIVE remote head;
//   - remote == last-observed anchor → safe (only replays our own state);
//   - else rev-list --cherry-pick --right-only new...remote ^base — any commit
//     the remote carries that is NOT already incorporated (by patch-id) into the
//     push, and is not part of the base's known history, REFUSES the push
//     (naming the commits) rather than discarding it;
//   - the lease is an EXPLICIT anchor (`--force-with-lease=<ref>:<sha>`), never
//     a bare `--force`; any unverifiable state fails closed.
//
// Commit + push are MUTATING → the nested jail (`jailedGit`); ls-remote / fetch
// / rev-list / rev-parse are read-only → the host runner (`hostGit`).

import { isZeroSHA, type Git } from "../git";
import { shortSHA, normalizedBranchRef, type Step, type StepContext, type StepOutcome } from "./common";

export const pushStep: Step = {
  name: "push",
  execute: executePush,
};

/** How to push a head to a remote branch safely (forcepush.go). */
export interface ForcePushDecision {
  /** Current remote head; the lease anchor for a force-push. */
  remoteSHA: string;
  /** Branch absent on the remote → plain push. */
  newBranch: boolean;
  /** Remote already at this head → nothing to push. */
  upToDate: boolean;
}

/** Refusal: a force-push would discard commits the remote carries that the
 *  pipeline never incorporated. Verbatim forcePushWouldDiscardError. */
export class ForcePushWouldDiscardError extends Error {
  constructor(
    readonly ref: string,
    readonly remoteSHA: string,
    readonly dropped: string[],
  ) {
    const sample = dropped.slice(0, 5).map(shortSHA);
    super(
      `refusing to force-push ${ref}: remote head ${shortSHA(remoteSHA)} carries ${dropped.length} ` +
        `commit(s) the pipeline never incorporated (e.g. ${sample.join(", ")}); pushing would discard ` +
        `upstream work. Re-fetch and rebase onto the current remote, or push manually if this overwrite ` +
        `is intended.`,
    );
    this.name = "ForcePushWouldDiscardError";
  }
}

/**
 * Re-read the remote head and decide whether force-pushing newHeadSHA would
 * discard commits the pipeline never saw. Returns a decision, or throws (fail
 * closed) when git fails or the push would discard unseen upstream commits.
 * Verbatim resolveForcePushDecision.
 */
export async function resolveForcePushDecision(
  git: Git,
  pushRemote: string,
  ref: string,
  newHeadSHA: string,
  lastSeenSHA: string,
  baseSHA: string,
): Promise<ForcePushDecision> {
  let current: string;
  try {
    current = await git.lsRemoteSHA(pushRemote, ref);
  } catch (err) {
    throw new Error(`resolve remote head for ${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (current === "") return { remoteSHA: "", newBranch: true, upToDate: false };
  if (current === newHeadSHA) return { remoteSHA: current, newBranch: false, upToDate: true };
  if (lastSeenSHA !== "" && current === lastSeenSHA) {
    // Remote unchanged since we last observed it: the force-push only rewrites
    // history we built on or last produced ourselves.
    return { remoteSHA: current, newBranch: false, upToDate: false };
  }
  let dropped: string[];
  try {
    dropped = await remoteCommitsNotIncorporated(git, pushRemote, ref, newHeadSHA, current, baseSHA);
  } catch (err) {
    throw new Error(`verify force-push safety for ${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dropped.length === 0) return { remoteSHA: current, newBranch: false, upToDate: false };
  throw new ForcePushWouldDiscardError(ref, current, dropped);
}

/**
 * Commits reachable from remoteSHA whose changes are not already present (by
 * patch-id) in newHeadSHA and are not part of the history the run already knew
 * (reachable from baseSHA). Fetches the remote tip into FETCH_HEAD first. Verbatim
 * remoteCommitsNotIncorporated — the --cherry-pick patch-id check is what stays
 * correct across rebases (replayed commits recognized, out-of-band commits caught).
 */
export async function remoteCommitsNotIncorporated(
  git: Git,
  pushRemote: string,
  ref: string,
  newHeadSHA: string,
  remoteSHA: string,
  baseSHA: string,
): Promise<string[]> {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  try {
    await git.run("fetch", "--no-tags", pushRemote, `refs/heads/${branch}`);
  } catch (err) {
    throw new Error(`fetch remote branch: ${err instanceof Error ? err.message : String(err)}`);
  }
  const args = ["rev-list", "--cherry-pick", "--right-only", `${newHeadSHA}...${remoteSHA}`];
  if (baseSHA !== "" && !isZeroSHA(baseSHA)) {
    if ((await git.revParseVerify(`${baseSHA}^{commit}`)) !== null) args.push(`^${baseSHA}`);
  }
  const out = await git.run(...args);
  return out
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The remote head the rebase step last fetched for this branch (the lease
 *  anchor); "" when no tracking ref exists. Verbatim lastFetchedBranchTip. */
async function lastFetchedBranchTip(git: Git, branch: string): Promise<string> {
  const sha = await git.revParseVerify(`refs/remotes/origin/${branch}^{commit}`);
  return sha ?? "";
}

async function executePush(sctx: StepContext): Promise<StepOutcome> {
  let newHeadSHA = "";

  // Commit any uncommitted agent fixes (mutating → jailed).
  const status = await sctx.hostGit.statusPorcelain();
  if (status.trim() !== "") {
    sctx.log("committing agent changes...");
    await sctx.jailedGit.run("add", "-A");
    await sctx.jailedGit.run("commit", "-m", "ez-code-factory: apply agent fixes");
    newHeadSHA = await sctx.hostGit.headSha();
  }

  const ref = normalizedBranchRef(sctx.run.branch);
  const branch = ref.slice("refs/heads/".length);
  const pushRemote = "origin";

  sctx.log(`pushing to ${pushRemote} (${ref})...`);
  const headBeingPushed = await sctx.hostGit.headSha();
  const lastSeen = await lastFetchedBranchTip(sctx.hostGit, branch);
  const decision = await resolveForcePushDecision(
    sctx.hostGit,
    pushRemote,
    ref,
    headBeingPushed,
    lastSeen,
    sctx.run.baseSha,
  );

  if (decision.newBranch) {
    await sctx.jailedGit.push(pushRemote, ref, "", false);
  } else if (decision.upToDate) {
    // Remote already at this head — nothing to push.
  } else {
    await sctx.jailedGit.push(pushRemote, ref, decision.remoteSHA, true);
  }

  if (newHeadSHA !== "") {
    await sctx.jailedGit.run("update-ref", ref, newHeadSHA);
  }

  const headSha = await sctx.hostGit.headSha();
  if (headSha !== sctx.run.headSha) {
    sctx.run.headSha = headSha;
    await sctx.updateHeadSha(headSha);
  }

  sctx.log("pushed successfully");
  return {};
}
