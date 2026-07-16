// ── code_factory_doctor — read-only health report (M6) ──────────────
//
// The upstream `doctor` equivalent: a single read-only pass that answers the
// operator's "why isn't my gate working?" questions in one place —
//   - gate initialized?      (the bare gate repo exists)
//   - hook installed+managed? (our marker is in the post-receive hook)
//   - gh available+authed?    (pr/ci can talk to GitHub)
//   - token set?              (the encrypted githubToken secret is present)
//   - default branch fetch?   (the gate has an origin to rebase/PR against)
//   - reconcile sweep healthy? (the background loop has fired)
//
// Every check is read-only (a `git`/`gh` probe or a Storage read) behind an
// injected seam, so the whole report is unit-tested with fakes. `fail` = the
// gate is broken; `warn` = degraded-but-usable (gh/token/PR paths skip-not-fail
// per spec §11); `ok` = nominal. `report.ok` is true iff nothing FAILED.

import { isManagedHook } from "./gate";
import type { GhRunner } from "./github";
import type { ShellRunner } from "./shell";
import type { SweepHeartbeat } from "./sweep";
import { join } from "node:path";

/** Per-check verdict: nominal / degraded-but-usable / broken. */
export type CheckStatus = "ok" | "warn" | "fail";

/** One diagnostic line. */
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** The full read-only report. `ok` is true iff no check FAILED (warns are
 *  degraded-but-usable states — an unauthenticated gh just skips pr/ci). */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  /** The gate bare-repo dir for the active project. */
  gateDir: string;
  /** The configured default branch (reported for context). */
  defaultBranch: string;
  /** Host runner for the read-only git + `cat` probes. */
  run: ShellRunner;
  /** gh runner (production injects GH_TOKEN); used for `gh auth status`. */
  gh: GhRunner;
  /** Resolve the GitHub token (env → encrypted secret → null). */
  resolveToken: () => Promise<string | null>;
  /** Read the reconcile-sweep heartbeat (null when it has not fired). */
  readHeartbeat: () => Promise<SweepHeartbeat | null>;
}

/** Gate initialized? (`git rev-parse --is-bare-repository` is `true`). */
async function checkGate(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.run(["git", "-C", deps.gateDir, "rev-parse", "--is-bare-repository"], deps.gateDir);
  if (r.exitCode === 0 && r.stdout.trim() === "true") {
    return { name: "gate", status: "ok", detail: `bare gate repo at ${deps.gateDir}` };
  }
  return {
    name: "gate",
    status: "fail",
    detail: `no bare gate repo at ${deps.gateDir} — run init_gate for this project`,
  };
}

/** Hook installed + managed? (our marker is present in post-receive). */
async function checkHook(deps: DoctorDeps): Promise<DoctorCheck> {
  const hookPath = join(deps.gateDir, "hooks", "post-receive");
  const r = await deps.run(["cat", hookPath], deps.gateDir);
  if (r.exitCode !== 0) {
    return { name: "hook", status: "fail", detail: `no post-receive hook at ${hookPath} — run init_gate` };
  }
  if (!isManagedHook(r.stdout)) {
    return {
      name: "hook",
      status: "warn",
      detail: `post-receive hook at ${hookPath} is NOT managed by this extension (left untouched)`,
    };
  }
  return { name: "hook", status: "ok", detail: "managed post-receive hook installed" };
}

/** gh available + authenticated? (pr/ci skip-not-fail when it is not). */
async function checkGh(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.gh(["auth", "status"]);
  if (r.exitCode === 0) return { name: "gh", status: "ok", detail: "gh CLI authenticated" };
  // 127 is the runner's "command not found" (lib/shell.ts): gh is not on PATH.
  const detail =
    r.exitCode === 127
      ? "gh CLI not found on PATH — pr/ci steps will skip (install gh to enable them)"
      : "gh CLI is not authenticated — pr/ci steps will skip (set the githubToken secret or run gh auth login)";
  return { name: "gh", status: "warn", detail };
}

/** GitHub token set? (env override or the encrypted githubToken secret). */
async function checkToken(deps: DoctorDeps): Promise<DoctorCheck> {
  const token = await deps.resolveToken();
  if (token !== null) return { name: "token", status: "ok", detail: "githubToken configured" };
  return {
    name: "token",
    status: "warn",
    detail: "no githubToken secret set — gh falls back to its own ambient auth (gh auth login)",
  };
}

/** Default branch resolvable? (the gate has an origin to fetch/rebase against). */
async function checkDefaultBranch(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.run(["git", "-C", deps.gateDir, "remote", "get-url", "origin"], deps.gateDir);
  const url = r.stdout.trim();
  if (r.exitCode === 0 && url !== "") {
    return {
      name: "default-branch",
      status: "ok",
      detail: `origin → ${url}; runs rebase/PR against '${deps.defaultBranch}'`,
    };
  }
  return {
    name: "default-branch",
    status: "warn",
    detail: `gate has no origin remote — runs cannot fetch '${deps.defaultBranch}' or open PRs (re-run init_gate with an upstream)`,
  };
}

/** Reconcile-sweep loop healthy? (a heartbeat means the cron has fired). */
async function checkSweep(deps: DoctorDeps): Promise<DoctorCheck> {
  const hb = await deps.readHeartbeat();
  if (!hb) {
    return {
      name: "reconcile-sweep",
      status: "warn",
      detail: "reconcile sweep has not fired since boot (it runs on a cron; wait one interval)",
    };
  }
  const s = hb.summary;
  return {
    name: "reconcile-sweep",
    status: "ok",
    detail: `last swept ${hb.ranAt} — scanned ${s.scanned}, advanced ${s.advanced}, still-parked ${s.stillParked}`,
  };
}

/**
 * Run every diagnostic check (read-only) and assemble the report. All checks
 * run (no short-circuit) so a single failure never hides the rest; `ok` is true
 * iff nothing has `status: "fail"`.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    await checkGate(deps),
    await checkHook(deps),
    await checkGh(deps),
    await checkToken(deps),
    await checkDefaultBranch(deps),
    await checkSweep(deps),
  ];
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
