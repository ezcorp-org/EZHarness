// ── Gate provisioning — the git-interception layer ───────────────────
//
// A "gate" is a LOCAL bare git repo that sits in front of the real remote.
// `git push gate <branch>` lands objects in the bare repo (fast, local, always
// succeeds); its `post-receive` hook POSTs the platform's generic
// extension-events route, handing control to this extension. `origin` on the
// working repo is never touched.
//
// Everything here is either a PURE helper (repo-id, paths, hook content,
// managed-hook detection, remote-wiring decision) or an orchestration function
// that takes an injectable `ShellRunner`, so the whole module is exercised
// end-to-end against a throwaway git repo in tests.

import { dirname, join } from "node:path";
import type { ShellRunner } from "./shell";
import { shQuote } from "./shell";

/** Manifest slug — the data-dir + events-route namespace. */
export const EXTENSION_NAME = "ez-code-factory";
/** Cosmetic git remote name for the push UX (`git push gate <branch>`).
 *  Decided at M0 per the spec; a future settings knob could rename it. */
export const GATE_REMOTE = "gate";
/** The registered Hub action the post-receive hook triggers. Full event name
 *  is `${EXTENSION_NAME}:${TRIGGER_EVENT}`. */
export const TRIGGER_EVENT = "push-received";
/** Hub page id (also the events-route `pageId`). */
export const PAGE_ID = "dashboard";
/** Default EZCorp server base URL the hook POSTs to. Overridable at init. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/** Marker line proving a hook is OURS — only marked/absent hooks are ever
 *  overwritten (a foreign hook is left untouched). Versioned so a future hook
 *  revision can force a refresh without clobbering a user's custom hook. */
export const HOOK_MARKER = "ez-code-factory:managed-post-receive:v1";

/**
 * Gate repo id = first 12 hex chars of sha256(absolute project path). Stable
 * per checkout, collision-safe enough to name one bare repo per project. Pure.
 */
export function repoId(absProjectRoot: string): string {
  return new Bun.CryptoHasher("sha256").update(absProjectRoot).digest("hex").slice(0, 12);
}

/** `<projectRoot>/.ezcorp/extension-data/ez-code-factory`. Pure. */
export function dataDir(projectRoot: string): string {
  return join(projectRoot, ".ezcorp", "extension-data", EXTENSION_NAME);
}
/** `<dataDir>/repos` — parent of every gate bare repo. Pure. */
export function reposDir(projectRoot: string): string {
  return join(dataDir(projectRoot), "repos");
}
/** `<reposDir>/<repoId>.git` — the bare gate repo for a project. Pure. */
export function gateDir(projectRoot: string, id: string): string {
  return join(reposDir(projectRoot), `${id}.git`);
}
/** Path the hook reads its minted key from (path-to-credential). Pure. */
export function credentialPath(projectRoot: string): string {
  return join(dataDir(projectRoot), "gate-key");
}
/** Where the hook appends notify failures. Pure. */
export function notifyLogPath(gateRepoDir: string): string {
  return join(gateRepoDir, "notify-push.log");
}

/**
 * Accept only an upstream URL safe to store as the gate repo's `origin` and
 * hand to `git remote add` / `git fetch`: an `https://` or `ssh://` URL, or the
 * scp-like `user@host:path` form. Rejects transports that can execute a command
 * at fetch time (`ext::…`), local `file://` paths, empty/whitespace, and
 * anything flag-shaped (`-…`) that `git` could parse as an option. Pure — no IO.
 *
 * This gates the EXPLICIT `upstream` tool argument only (an attacker-influenced
 * input); the implicit fallback — the working repo's own `origin` — is already
 * user-configured and trusted. Forecloses an M1 RCE-at-fetch footgun the moment
 * the gate first fetches upstream.
 */
export function isSafeUpstreamUrl(url: string): boolean {
  const u = url.trim();
  if (!u || u.startsWith("-")) return false;
  // https:// or ssh:// (no whitespace).
  if (/^(?:https|ssh):\/\/\S+$/i.test(u)) return true;
  // scp-like [user@]host:path — a host is required, no leading colon.
  if (/^[\w.+-]+@[\w.-]+:\S+$/.test(u)) return true;
  return false;
}

/** Options threaded into the generated post-receive hook. */
export interface HookScriptOptions {
  repoId: string;
  baseUrl: string;
  credentialPath: string;
  notifyLogPath: string;
}

/**
 * Generate the managed `post-receive` hook (POSIX sh). It ALWAYS exits 0 (a
 * gate must never block a push), reads the minted key from a credential FILE
 * (never inlined here — path-to-credential), forwards old/new/ref + push
 * options to the extension-events route, and appends any notify failure to
 * `notify-push.log` while echoing a banner to the pusher's stderr. Pure — the
 * returned string is deterministic given its options.
 */
export function hookScript(opts: HookScriptOptions): string {
  const endpoint = `/api/extensions/${EXTENSION_NAME}/events/${TRIGGER_EVENT}`;
  return `#!/bin/sh
# ${HOOK_MARKER}
# Managed by the ez-code-factory extension. Do NOT edit — re-running init_gate
# rewrites this file. A gate must never block a push: this hook ALWAYS exits 0.
set -u

REPO_ID=${shQuote(opts.repoId)}
BASE_URL=${shQuote(opts.baseUrl)}
ENDPOINT=${shQuote(endpoint)}
PAGE_ID=${shQuote(PAGE_ID)}
CRED_FILE=${shQuote(opts.credentialPath)}
NOTIFY_LOG=${shQuote(opts.notifyLogPath)}

log_fail() {
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
  printf '%s %s\\n' "$ts" "$1" >> "$NOTIFY_LOG" 2>/dev/null || true
  printf 'ez-code-factory: %s\\n' "$1" 1>&2
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | tr '\\n\\r\\t' '   '
}

# Collect push options (\`--push-option\`/\`-o\`) into a JSON array of strings.
OPTS='[]'
if [ "\${GIT_PUSH_OPTION_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  OPTS=''
  i=0
  while [ "$i" -lt "$GIT_PUSH_OPTION_COUNT" ]; do
    eval "opt=\\\${GIT_PUSH_OPTION_$i:-}"
    esc=$(json_escape "$opt")
    if [ -z "$OPTS" ]; then OPTS="\\"$esc\\""; else OPTS="$OPTS,\\"$esc\\""; fi
    i=$((i + 1))
  done
  OPTS="[$OPTS]"
fi

KEY=$(cat "$CRED_FILE" 2>/dev/null || true)
if [ -z "$KEY" ]; then
  log_fail "no gate credential at $CRED_FILE — run: ezcorp key mint --scopes read,chat > $CRED_FILE"
fi

while read -r oldrev newrev refname; do
  # A gate acts only on branch updates. Skip non-branch refs (tags, notes, …)
  # and deletions (a delete sends an all-zero newrev): neither has a commit to
  # check out, and creating a run for one only produces a junk "failed" row.
  # A skipped ref still leaves the push itself untouched (the hook exits 0).
  case "$refname" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  case "$newrev" in
    *[!0]*) ;;
    *) continue ;;
  esac
  branch=\${refname#refs/heads/}
  # JSON-escape ref + branch: a double quote is legal in a git ref name and
  # would otherwise break this hand-built body (invalid JSON → 400 → a silent
  # drop). The sha fields and the hex repo id never need escaping.
  esc_ref=$(json_escape "$refname")
  esc_branch=$(json_escape "$branch")
  BODY="{\\"source\\":\\"hub\\",\\"pageId\\":\\"$PAGE_ID\\",\\"payload\\":{\\"repoId\\":\\"$REPO_ID\\",\\"ref\\":\\"$esc_ref\\",\\"branch\\":\\"$esc_branch\\",\\"oldSha\\":\\"$oldrev\\",\\"newSha\\":\\"$newrev\\",\\"pushOptions\\":$OPTS}}"
  if [ -n "$KEY" ]; then
    if command -v curl >/dev/null 2>&1; then
      # -sS stays quiet but surfaces transport errors; -w captures the HTTP
      # status so an HTTP >=400 (401/404/429/5xx) is a VISIBLE failure — curl's
      # exit code alone is 0 for a 4xx/5xx, which would drop the push silently.
      # A gate never blocks a push: every failure is logged + echoed to the
      # pusher's stderr, and the hook still exits 0.
      http=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE_URL$ENDPOINT" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$BODY" 2>/dev/null)
      rc=$?
      if [ "$rc" -ne 0 ]; then
        log_fail "trigger POST failed for $branch (curl exit $rc)"
      elif [ "$http" -ge 400 ] 2>/dev/null; then
        log_fail "trigger POST failed for $branch: HTTP $http"
      fi
    else
      log_fail "curl not found — cannot notify gate for $branch"
    fi
  fi
done

exit 0
`;
}

/** True iff `content` is a hook this extension wrote (carries the marker). Pure. */
export function isManagedHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

/** What init should do with the working repo's `gate` remote. */
export type RemoteWiringAction = "add" | "repoint" | "noop" | "refuse";

/**
 * Decide how to wire the `gate` remote WITHOUT clobbering a foreign URL:
 *   - no existing remote            → `add`
 *   - already our exact gate dir    → `noop` (idempotent re-init)
 *   - a sibling under our reposDir  → `repoint` (stale gate id, ours to fix)
 *   - anything else                 → `refuse` (foreign — never clobber)
 * `file://` prefixes are normalized away before comparison. Pure.
 */
export function decideRemoteWiring(
  existingUrl: string | null,
  targetGateDir: string,
  gateReposDir: string,
): RemoteWiringAction {
  if (existingUrl === null || existingUrl === "") return "add";
  const normalized = existingUrl.replace(/^file:\/\//, "");
  if (normalized === targetGateDir) return "noop";
  if (dirname(normalized) === gateReposDir) return "repoint";
  return "refuse";
}

/** Structured init result — surfaced verbatim by the `init_gate` tool. */
export interface InitGateResult {
  ok: boolean;
  repoId: string;
  gateDir: string;
  gateRemote: string;
  credentialPath: string;
  bareCreated: boolean;
  hookAction: "written" | "refreshed" | "skipped-foreign";
  remoteAction: RemoteWiringAction;
  warnings: string[];
  error?: string;
}

/** Read a remote's URL, or null when the remote does not exist. */
async function remoteUrl(run: ShellRunner, repo: string, name: string): Promise<string | null> {
  const res = await run(["git", "-C", repo, "remote", "get-url", name], repo);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/**
 * Idempotently provision the gate for `projectRoot`: bare repo, managed hook,
 * push-option advertisement + per-worktree hook isolation, gate-repo `origin`
 * pointed at upstream, and a `gate` remote on the working repo (foreign URLs
 * refused). Every mutation goes through the injected `run`; safe to re-run.
 */
export async function initGate(opts: {
  projectRoot: string;
  upstream?: string;
  baseUrl?: string;
  run: ShellRunner;
}): Promise<InitGateResult> {
  const { projectRoot, run } = opts;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const id = repoId(projectRoot);
  const gDir = gateDir(projectRoot, id);
  const rDir = reposDir(projectRoot);
  const credPath = credentialPath(projectRoot);
  const warnings: string[] = [];

  const result: InitGateResult = {
    ok: false,
    repoId: id,
    gateDir: gDir,
    gateRemote: GATE_REMOTE,
    credentialPath: credPath,
    bareCreated: false,
    hookAction: "written",
    remoteAction: "noop",
    warnings,
  };

  // 1. Bare repo (idempotent). Probe first so we can report new-vs-existing.
  const bareProbe = await run(["git", "-C", gDir, "rev-parse", "--is-bare-repository"], projectRoot);
  const alreadyBare = bareProbe.exitCode === 0 && bareProbe.stdout.trim() === "true";
  if (!alreadyBare) {
    const init = await run(["git", "init", "--bare", gDir], projectRoot);
    if (init.exitCode !== 0) {
      result.error = `git init --bare failed (exit ${init.exitCode}): ${init.stderr.trim() || init.stdout.trim()}`;
      return result;
    }
    result.bareCreated = true;
  }

  // 2. Gate-repo config. advertisePushOptions is required; the worktree-config
  //    isolation is best-effort (a no-op on git too old to know the key).
  const adv = await run(
    ["git", "-C", gDir, "config", "receive.advertisePushOptions", "true"],
    projectRoot,
  );
  if (adv.exitCode !== 0) {
    result.error = `failed to set receive.advertisePushOptions (exit ${adv.exitCode}): ${adv.stderr.trim()}`;
    return result;
  }
  const wtCfg = await run(
    ["git", "-C", gDir, "config", "extensions.worktreeConfig", "true"],
    projectRoot,
  );
  if (wtCfg.exitCode !== 0) {
    warnings.push("extensions.worktreeConfig unsupported by this git — per-worktree hook isolation skipped");
  }

  // 3. Point the gate repo's `origin` at the project's real upstream. An
  //    EXPLICIT `upstream` (attacker-influenceable tool arg) must clear the
  //    scheme allowlist; otherwise mirror the working repo's own — trusted —
  //    `origin`. `--end-of-options` stops git parsing a `-`-shaped URL as a flag
  //    (belt-and-suspenders with the allowlist's leading-`-` rejection).
  let upstream: string | null;
  if (opts.upstream !== undefined) {
    upstream = isSafeUpstreamUrl(opts.upstream) ? opts.upstream : null;
    if (upstream === null) {
      warnings.push(
        `ignoring unsafe upstream URL '${opts.upstream}' — allowed: https://, ssh://, or user@host:path`,
      );
    }
  } else {
    upstream = await remoteUrl(run, projectRoot, "origin");
  }
  if (upstream) {
    const gateOrigin = await remoteUrl(run, gDir, "origin");
    const cmd = gateOrigin === null
      ? ["git", "-C", gDir, "remote", "add", "--end-of-options", "origin", upstream]
      : ["git", "-C", gDir, "remote", "set-url", "--end-of-options", "origin", upstream];
    const originRes = await run(cmd, projectRoot);
    if (originRes.exitCode !== 0) {
      warnings.push(`could not set gate origin → ${upstream} (exit ${originRes.exitCode})`);
    }
  } else if (opts.upstream === undefined) {
    warnings.push("no upstream found (working repo has no 'origin'); gate 'origin' left unset");
  }

  // 4. Managed post-receive hook (marker-gated, atomic write, mode 0755).
  const hookPath = join(gDir, "hooks", "post-receive");
  const existing = await run(["cat", hookPath], projectRoot);
  const hadHook = existing.exitCode === 0;
  if (hadHook && !isManagedHook(existing.stdout)) {
    result.hookAction = "skipped-foreign";
    warnings.push(`existing post-receive hook is not ours — left untouched at ${hookPath}`);
  } else {
    const content = hookScript({
      repoId: id,
      baseUrl,
      credentialPath: credPath,
      notifyLogPath: notifyLogPath(gDir),
    });
    const tmp = `${hookPath}.tmp`;
    const writeCmd =
      `mkdir -p ${shQuote(join(gDir, "hooks"))} && ` +
      `printf '%s' ${shQuote(content)} > ${shQuote(tmp)} && ` +
      `chmod 0755 ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(hookPath)}`;
    const write = await run(["sh", "-c", writeCmd], projectRoot);
    if (write.exitCode !== 0) {
      result.error = `failed to install post-receive hook (exit ${write.exitCode}): ${write.stderr.trim()}`;
      return result;
    }
    result.hookAction = hadHook ? "refreshed" : "written";
  }

  // 4b. Best-effort: tighten the gate credential's mode if it already exists,
  //     so a key dropped with a lax umask isn't left group/world-readable. The
  //     hook reads this file at push time; the gate never fails on the chmod.
  const credProbe = await run(["test", "-f", credPath], projectRoot);
  if (credProbe.exitCode === 0) {
    const chmodRes = await run(["chmod", "0600", credPath], projectRoot);
    if (chmodRes.exitCode !== 0) {
      warnings.push(`could not tighten gate credential mode at ${credPath} (best-effort)`);
    }
  }

  // 5. Wire the `gate` remote on the working repo (never clobber a foreign URL).
  const existingRemote = await remoteUrl(run, projectRoot, GATE_REMOTE);
  const decision = decideRemoteWiring(existingRemote, gDir, rDir);
  result.remoteAction = decision;
  if (decision === "add" || decision === "repoint") {
    const verb = decision === "add" ? "add" : "set-url";
    const wire = await run(
      ["git", "-C", projectRoot, "remote", verb, GATE_REMOTE, gDir],
      projectRoot,
    );
    if (wire.exitCode !== 0) {
      result.error = `failed to ${verb} '${GATE_REMOTE}' remote (exit ${wire.exitCode}): ${wire.stderr.trim()}`;
      return result;
    }
  } else if (decision === "refuse") {
    warnings.push(
      `remote '${GATE_REMOTE}' already points at a foreign URL (${existingRemote}) — refusing to clobber; ` +
        `remove it or rename this gate's remote manually`,
    );
  }

  result.ok = true;
  return result;
}
