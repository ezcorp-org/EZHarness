// ── code_factory_doctor — read-only health report (M6) ──────────────
//
// The upstream `doctor` equivalent: a single read-only pass that answers the
// operator's "why isn't my gate working?" questions in one place —
//   - gate initialized?      (the bare gate repo exists)
//   - hook installed+managed? (our marker is in the post-receive hook)
//   - gh available+authed?    (pr/ci can talk to GitHub)
//   - token set?              (the encrypted github_token secret is present)
//   - default branch fetch?   (the gate has an origin to rebase/PR against)
//   - reconcile sweep healthy? (the background loop has fired)
//
// Every check is read-only (a `git`/`gh` probe or a Storage read) behind an
// injected seam, so the whole report is unit-tested with fakes. `fail` = the
// gate is broken; `warn` = degraded-but-usable (gh/token/PR paths skip-not-fail
// per spec §11); `ok` = nominal. `report.ok` is true iff nothing FAILED.

import { isManagedHook, mintCredentialCommand } from "./gate";
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
  /** Path the hook reads its minted key from (`credentialPath(projectRoot)`). */
  credentialPath: string;
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

/** Gate credential present + non-empty? The managed hook reads its minted key
 *  from this FILE at push time; a missing/empty key makes it log one line and
 *  exit 0 — every push is accepted but silently DROPPED, so the dashboard stays
 *  empty forever (the #1 silent-setup gap). `test -s` = exists AND non-empty. */
async function checkCredential(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.run(["test", "-s", deps.credentialPath], deps.gateDir);
  if (r.exitCode === 0) {
    return { name: "credential", status: "ok", detail: `gate credential present at ${deps.credentialPath}` };
  }
  return {
    name: "credential",
    status: "fail",
    detail:
      `no gate credential at ${deps.credentialPath} — the post-receive hook drops every push ` +
      `(accepted but never recorded). Mint one: ${mintCredentialCommand(deps.credentialPath)}`,
  };
}

/** `curl` available on PATH in the environment the hook runs in? The hook POSTs
 *  the push-received event with curl; if it is not on PATH it logs one line to
 *  notify-push.log and exits 0 — every push is silently dropped. `command -v` is
 *  a shell builtin, so it runs via `sh -c` (a bare `["command", …]` argv would
 *  just 127 as a missing binary). */
async function checkCurl(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.run(["sh", "-c", "command -v curl"], deps.gateDir);
  if (r.exitCode === 0) {
    const path = r.stdout.trim();
    return {
      name: "curl",
      status: "ok",
      detail: path
        ? `curl available (${path}) — the hook can POST push events`
        : "curl available — the hook can POST push events",
    };
  }
  return {
    name: "curl",
    status: "fail",
    detail:
      "curl not found on PATH — the post-receive hook cannot POST push events, so every push is " +
      "silently dropped (install curl in the environment the hook runs in)",
  };
}

/** gh available + authenticated? (pr/ci skip-not-fail when it is not). */
async function checkGh(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.gh(["auth", "status"]);
  if (r.exitCode === 0) return { name: "gh", status: "ok", detail: "gh CLI authenticated" };
  // 127 is the runner's "command not found" (lib/shell.ts): gh is not on PATH.
  const detail =
    r.exitCode === 127
      ? "gh CLI not found on PATH — pr/ci steps will skip (install gh to enable them)"
      : "gh CLI is not authenticated — pr/ci steps will skip (set the GitHub token secret or run gh auth login)";
  return { name: "gh", status: "warn", detail };
}

/** GitHub token set? (env override or the encrypted github_token secret). The
 *  detail NEVER echoes the resolved token value — only whether one is present. */
async function checkToken(deps: DoctorDeps): Promise<DoctorCheck> {
  const token = await deps.resolveToken();
  if (token !== null) return { name: "token", status: "ok", detail: "GitHub token configured" };
  return {
    name: "token",
    status: "warn",
    detail: "no GitHub token secret set — gh falls back to its own ambient auth (gh auth login)",
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

/** Trusted upstream fetchable? `resolveTrustedRepoConfig` does `git fetch origin
 *  <defaultBranch>` BEFORE any step; a gate whose origin is unreachable /
 *  unauthenticated fail-closes EVERY run at "trusted config unreadable: … failed
 *  to fetch or resolve trusted default branch" before an agent ever launches.
 *  `git ls-remote` hits the SAME connect/auth path read-only (no object
 *  download), so it is the cheapest faithful probe of that precondition. A
 *  missing origin is left to `checkDefaultBranch` (deferred to as a warn) rather
 *  than double-reported as a fetch failure with no URL to fetch. */
async function checkTrustedUpstream(deps: DoctorDeps): Promise<DoctorCheck> {
  const origin = await deps.run(["git", "-C", deps.gateDir, "remote", "get-url", "origin"], deps.gateDir);
  const url = origin.stdout.trim();
  if (origin.exitCode !== 0 || url === "") {
    return {
      name: "trusted-upstream",
      status: "warn",
      detail:
        `gate has no origin remote to fetch '${deps.defaultBranch}' from — see the default-branch ` +
        `check (re-run init_gate with an upstream)`,
    };
  }
  const r = await deps.run(
    ["git", "-C", deps.gateDir, "ls-remote", "--heads", "origin", deps.defaultBranch],
    deps.gateDir,
  );
  if (r.exitCode === 0) {
    return {
      name: "trusted-upstream",
      status: "ok",
      detail: `origin (${url}) reachable — the trusted-config fetch of '${deps.defaultBranch}' can connect`,
    };
  }
  return {
    name: "trusted-upstream",
    status: "fail",
    detail:
      `gate origin '${url}' is not fetchable — every run fail-closes at "trusted config unreadable: ` +
      `… failed to fetch or resolve trusted default branch '${deps.defaultBranch}'" before any step: ` +
      `${r.stderr.trim() || r.stdout.trim() || `git ls-remote origin ${deps.defaultBranch} exited ${r.exitCode}`}`,
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
    await checkCredential(deps),
    await checkCurl(deps),
    await checkGh(deps),
    await checkToken(deps),
    await checkDefaultBranch(deps),
    await checkTrustedUpstream(deps),
    await checkSweep(deps),
  ];
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
