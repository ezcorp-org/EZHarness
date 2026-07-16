// ── Rebase step — port of internal/pipeline/steps/rebase.go ─────────
//
// Syncs the pushed branch with a fresh origin/<default> (and the pushed-branch
// tracking ref on a NORMAL push). The two load-bearing behaviours ported exactly:
//
//   1. Force-push anchor asymmetry (spec §1 invariant 3): on a force push we
//      deliberately do NOT refresh the pushed-branch remote-tracking ref, so it
//      stays the head we last *observed* rather than the live tip. The push step
//      uses that stale ref as its force-with-lease anchor; refreshing it here
//      would make the lease's "remote unchanged" fast path pass even when the
//      remote carries an out-of-band commit — silently clobbering it.
//   2. Bundled-local-default guard: stop (ask-user) when the branch carries
//      commits that live on the contributor's local default branch but were
//      never pushed to origin/<default>, so a rebase would bundle another
//      workstream's unpushed work into the PR.
//
// GitHub-only (origin remote); the upstream fork/pushURL path is out of scope.

import { isZeroSHA } from "../git";
import { serializeFindings, deserializeFindings, type Finding } from "../runs";
import { userIntentPromptSection } from "../prompts";
import { COMMIT_SUMMARY_SCHEMA } from "../prompts";
import {
  intentIsAuthoritative,
  resolveBranchBaseSHA,
  shortSHA,
  type Step,
  type StepContext,
  type StepOutcome,
  gitAt,
} from "./common";
import { join, isAbsolute } from "node:path";

const REBASE_STEP_FILE = "docs/extensions/examples/ez-code-factory/lib/steps/rebase.ts";

export const rebaseStep: Step = {
  name: "rebase",
  execute: executeRebase,
};

function branchName(run: StepContext["run"]): string {
  return run.branch.startsWith("refs/heads/") ? run.branch.slice("refs/heads/".length) : run.branch;
}

async function executeRebase(sctx: StepContext): Promise<StepOutcome> {
  const branch = branchName(sctx.run);
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const branchTarget = branch !== "" ? `origin/${branch}` : "";

  // Detect force push BEFORE fetching so we can skip the pushed-branch sync.
  const forcePush = await isForcePushAgainstRemote(sctx, "origin", branch, branchTarget, sctx.run.baseSha);

  sctx.log("fetching latest upstream state...");
  const fetchDefault = await sctx.hostGit.fetchRemoteBranch("origin", defaultBranch);
  if (fetchDefault.exitCode !== 0) {
    sctx.log(`warning: could not fetch origin/${defaultBranch}`);
  }
  // Sync the push branch's tracking ref ONLY on a normal push (see header §1).
  if (!forcePush && branch !== "" && branch !== defaultBranch) {
    const fetchBranch = await sctx.hostGit.fetchRemoteBranch("origin", branch);
    if (fetchBranch.exitCode !== 0) {
      sctx.log(`warning: could not fetch origin/${branch}`);
    }
  }

  const bundled = await detectBundledLocalDefaultCommits(sctx, branch, defaultBranch);
  if (bundled !== null) return bundled;

  if (forcePush && branch === defaultBranch && (await remoteDefaultBranchAdvanced(sctx, defaultBranch, sctx.run.baseSha))) {
    const findings = serializeFindings(
      deserializeFindings({
        findings: [
          {
            severity: "warning",
            file: REBASE_STEP_FILE,
            description: `origin/${defaultBranch} advanced after the force push; manual review required before updating the default branch`,
            action: "ask-user",
          },
        ],
        summary: `remote ${defaultBranch} advanced during force push`,
      }),
    );
    return { needsApproval: true, findings };
  }

  let targets = rebaseTargets(branch, defaultBranch, branchTarget);
  if (forcePush) {
    sctx.log(`force push detected, skipping ${branchTarget} sync`);
    targets = forcePushRebaseTargets(branch, defaultBranch);
  }

  if (sctx.fixing) {
    for (const target of targets) {
      await rebaseWithAgent(sctx, target);
    }
    return updateHeadSHA(sctx);
  }

  const conflictTargets: string[] = [];
  const conflictFindings: Finding[] = [];
  for (const target of targets) {
    const conflictFiles = await tryRebase(sctx, target);
    if (conflictFiles.length > 0) {
      conflictTargets.push(target);
      for (const file of conflictFiles) {
        conflictFindings.push(
          deserializeFindings({
            findings: [
              { severity: "warning", file, description: `merge conflict rebasing onto ${target}`, action: "auto-fix" },
            ],
          }).items[0]!,
        );
      }
    }
  }

  if (conflictTargets.length > 0) {
    const findings = serializeFindings(
      deserializeFindings({
        findings: dedupeRebaseFindings(conflictFindings).map((f) => ({
          severity: f.severity,
          file: f.file,
          description: f.description,
          action: f.action,
        })),
        summary: `conflict rebasing onto ${conflictTargets.join(", ")}`,
      }),
    );
    return { needsApproval: true, autoFixable: true, findings };
  }

  return updateHeadSHA(sctx);
}

/** Ordered refs to rebase onto (pushed-branch tracking ref, then default). */
function rebaseTargets(branch: string, defaultBranch: string, branchTarget: string): string[] {
  const targets: string[] = [];
  if (branch !== "" && branch !== defaultBranch) targets.push(branchTarget);
  if (branch !== defaultBranch) targets.push(`origin/${defaultBranch}`);
  return targets;
}

/** Force-push targets: skip the pushed-branch ref (may carry autofix commits the
 *  force-push intended to discard). Verbatim forcePushRebaseTargets. */
function forcePushRebaseTargets(branch: string, defaultBranch: string): string[] {
  if (branch === defaultBranch) return [];
  return [`origin/${defaultBranch}`];
}

/**
 * True when the push is non-fast-forward relative to the last-observed base and
 * the remote branch was rewritten. Uses the ancestry tri-state to preserve
 * git's exit-1 (not-ancestor) vs error distinction. Verbatim
 * isForcePushAgainstRemote.
 */
async function isForcePushAgainstRemote(
  sctx: StepContext,
  remote: string,
  branch: string,
  localRef: string,
  baseSha: string,
): Promise<boolean> {
  if (isZeroSHA(baseSha)) return false;
  const rel = await sctx.hostGit.ancestry(baseSha, "HEAD");
  if (rel === "yes") return false; // base is an ancestor → fast-forward, not force
  if (rel !== "no") return false; // git error → not force (fail safe)
  if (branch !== "") {
    let remoteSHA = "";
    try {
      remoteSHA = await sctx.hostGit.lsRemoteSHA(remote, `refs/heads/${branch}`);
    } catch {
      remoteSHA = "";
    }
    if (remoteSHA !== "") {
      const rel2 = await sctx.hostGit.ancestry(remoteSHA, "HEAD");
      if (rel2 === "yes") return false;
      if (rel2 === "no") return true;
    }
    if (localRef !== "" && (await sctx.hostGit.revParseVerify(localRef)) !== null) {
      return (await sctx.hostGit.ancestry(localRef, "HEAD")) === "no";
    }
  }
  return false;
}

async function remoteDefaultBranchAdvanced(sctx: StepContext, defaultBranch: string, baseSha: string): Promise<boolean> {
  if (isZeroSHA(baseSha)) return false;
  const remoteSHA = await sctx.hostGit.revParseVerify(`origin/${defaultBranch}`);
  if (remoteSHA === null) return false;
  return remoteSHA.trim() !== baseSha;
}

/**
 * Blocking ask-user finding when the branch carries local-default commits never
 * pushed to origin/<default>. Best-effort: returns null (proceed) whenever the
 * situation can't be read rather than guessing. Verbatim
 * detectBundledLocalDefaultCommits.
 */
async function detectBundledLocalDefaultCommits(
  sctx: StepContext,
  branch: string,
  defaultBranch: string,
): Promise<StepOutcome | null> {
  if (branch === "" || branch === defaultBranch) return null;
  const workingPath = sctx.repo.workingPath.trim();
  if (workingPath === "") return null;
  const localGit = gitAt(sctx, workingPath);
  const localTipRaw = await localGit.revParseVerify(`refs/heads/${defaultBranch}^{commit}`);
  if (localTipRaw === null || localTipRaw.trim() === "") return null;
  const localTip = localTipRaw.trim();
  const remoteRef = `origin/${defaultBranch}`;
  if ((await sctx.hostGit.revParseVerify(`${remoteRef}^{commit}`)) === null) return null;
  if ((await sctx.hostGit.revParseVerify(`${localTip}^{commit}`)) === null) return null;
  if ((await sctx.hostGit.ancestry(localTip, remoteRef)) === "yes") return null; // already pushed
  if ((await sctx.hostGit.ancestry(localTip, "HEAD")) !== "yes") return null; // branch doesn't carry it

  let subjects: string;
  try {
    subjects = await sctx.hostGit.run("log", "--oneline", "--no-decorate", `${remoteRef}..${localTip}`);
  } catch {
    return null;
  }
  if (subjects.trim() === "") return null;
  const commits = subjects.trim().split("\n");
  const files = await sctx.hostGit.diffNameOnly(remoteRef, localTip);
  const firstFile = files.length > 0 ? files[0]! : "";
  const description =
    `branch carries ${commits.length} commit(s) that exist on your local ${defaultBranch} branch but were ` +
    `never pushed to origin/${defaultBranch}; rebasing would bundle this unrelated work (${files.length} ` +
    `file(s)) into the PR:\n- ${commits.join("\n- ")}\n\nPush ${defaultBranch} to origin, or rebase your ` +
    `branch onto origin/${defaultBranch}, before gating.`;
  const findings = serializeFindings(
    deserializeFindings({
      findings: [{ severity: "warning", file: firstFile, description, action: "ask-user" }],
      summary: `branch bundles ${commits.length} unpushed ${defaultBranch} commit(s)`,
    }),
  );
  return { needsApproval: true, autoFixable: false, findings };
}

/** Try a rebase onto targetRef; return conflicted files (rebase aborted) or []. */
async function tryRebase(sctx: StepContext, target: string): Promise<string[]> {
  if (await shouldSkipRebase(sctx, target)) return [];
  sctx.log(`rebasing onto ${target}...`);
  const r = await sctx.jailedGit.try("rebase", target);
  if (r.exitCode === 0) return [];
  const conflictFiles = await rebaseConflictFiles(sctx);
  await sctx.jailedGit.try("rebase", "--abort");
  if (conflictFiles.length === 0) {
    throw new Error(`rebase onto ${target} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return conflictFiles;
}

/** Rebase onto targetRef, using the agent to resolve any conflicts (fix mode). */
async function rebaseWithAgent(sctx: StepContext, target: string): Promise<void> {
  if (await shouldSkipRebase(sctx, target)) return;
  sctx.log(`rebasing onto ${target}...`);
  const r = await sctx.jailedGit.try("rebase", target);
  if (r.exitCode === 0) return;
  if ((await rebaseConflictFiles(sctx)).length === 0) {
    await sctx.jailedGit.try("rebase", "--abort");
    throw new Error(`rebase onto ${target} failed (no conflicts detected)`);
  }
  sctx.log("conflicts detected, asking agent to resolve...");
  const conflictFiles = await rebaseConflictFiles(sctx);
  let prompt =
    `Resolve git rebase conflicts. The rebase of the current branch onto ${target} has conflicts.\n\n` +
    `Current conflicted files:\n- ${conflictFiles.join("\n- ")}\n\n` +
    `Instructions:\n` +
    `- Find all conflicting files and resolve the conflict markers (<<<<<<< ======= >>>>>>>).\n` +
    `- After resolving each file, stage it with: git add <file>\n` +
    `- After all conflicts are resolved, run: git rebase --continue\n` +
    `- If additional conflicts arise during rebase --continue, resolve those too.\n` +
    `- Do not modify any files that don't have conflicts.\n` +
    `- Preserve the intent of both the current branch changes and the upstream changes.\n` +
    `- Return JSON with a single "summary" field describing what you resolved.\n` +
    `- Keep the summary under 10 words.`;
  if (sctx.previousFindings !== "") prompt += `\n\nPrevious findings:\n${sctx.previousFindings}`;
  prompt += userIntentPromptSection({ intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) });

  try {
    await sctx.dispatcher.dispatch({
      role: "generic",
      prompt,
      cwd: sctx.worktree,
      jsonSchema: COMMIT_SUMMARY_SCHEMA,
    });
  } catch (err) {
    await sctx.jailedGit.try("rebase", "--abort");
    throw new Error(`agent resolve conflicts: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (await rebaseInProgress(sctx)) {
    await sctx.jailedGit.try("rebase", "--abort");
    throw new Error("agent did not complete the rebase");
  }
}

/** Whether a rebase onto targetRef can be skipped (missing / merged / ff). */
async function shouldSkipRebase(sctx: StepContext, target: string): Promise<boolean> {
  if ((await sctx.hostGit.revParseVerify(target)) === null) return true;
  const localSHA = await sctx.hostGit.headSha();
  const targetSHA = await sctx.hostGit.run("rev-parse", target);
  if (localSHA === targetSHA) {
    sctx.log(`already up-to-date with ${target}`);
    return true;
  }
  if ((await sctx.hostGit.ancestry(target, "HEAD")) === "yes") {
    sctx.log(`already ahead of ${target}`);
    return true;
  }
  if ((await sctx.hostGit.ancestry("HEAD", target)) === "yes") {
    sctx.log(`fast-forwarding to ${target}`);
    await sctx.jailedGit.run("reset", "--hard", target);
    return true;
  }
  return false;
}

/** True if a rebase is in progress (rebase-merge / rebase-apply dir exists). */
async function rebaseInProgress(sctx: StepContext): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    let p: string;
    try {
      p = await sctx.hostGit.run("rev-parse", "--git-path", dir);
    } catch {
      continue;
    }
    if (!isAbsolute(p)) p = join(sctx.worktree, p);
    const r = await sctx.hostRunner(["test", "-d", p], sctx.worktree);
    if (r.exitCode === 0) return true;
  }
  return false;
}

async function rebaseConflictFiles(sctx: StepContext): Promise<string[]> {
  const r = await sctx.hostGit.try("diff", "--name-only", "--diff-filter=U");
  if (r.exitCode !== 0) return [];
  return r.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Dedupe conflict findings on (file, description). Verbatim dedupeRebaseFindings. */
function dedupeRebaseFindings(findings: Finding[]): Finding[] {
  if (findings.length < 2) return findings;
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.file} ${f.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Sync the run head after rebase; empty diff vs default → SkipRemaining. */
async function updateHeadSHA(sctx: StepContext): Promise<StepOutcome> {
  const headSha = await sctx.hostGit.headSha();
  if (headSha !== "" && headSha !== sctx.run.headSha) {
    sctx.run.headSha = headSha;
    await sctx.updateHeadSha(headSha);
    sctx.log(`updated head SHA to ${shortSHA(headSha)}`);
  }
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSha = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const diff = await sctx.hostGit.try("diff", baseSha, "HEAD");
  if (diff.exitCode === 0 && diff.stdout.trim() === "") {
    sctx.log("empty diff after rebase, skipping remaining steps");
    return { skipRemaining: true };
  }
  return {};
}
