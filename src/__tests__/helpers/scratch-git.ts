/**
 * Scratch git repositories for tests that must never reach the real one.
 *
 * Git exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, GIT_COMMON_DIR,
 * GIT_OBJECT_DIRECTORY, GIT_PREFIX and friends to hook processes. A test that
 * runs `git init` in a tmpdir with that context inherited acts on the REAL
 * repository: on 2026-09-24 gate-scripts.test.ts, run by the pre-commit hook,
 * re-initialised the shared repository as bare and wrote its fixture identity
 * into the shared config. A scratch HOME and GIT_CONFIG_NOSYSTEM keep the
 * user's global and the host's system config (identity, hooks, signing) out of
 * the fixture as well.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type GitEnv = Record<string, string>;

/** Every variable except the `GIT_*` context a hook (or a parent git) exports. */
export function withoutGitContext(env: Record<string, string | undefined>): GitEnv {
  const out: GitEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("GIT_")) out[name] = value;
  }
  return out;
}

/**
 * `env` with no git context, `home` as HOME, and GIT_CONFIG_NOSYSTEM=1, so
 * neither the global nor the system git config is read.
 */
export function scratchGitEnv(home: string, env: Record<string, string | undefined> = process.env): GitEnv {
  const out = withoutGitContext(env);
  delete out.XDG_CONFIG_HOME;
  out.HOME = home;
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

export type ScratchRepository = {
  /** The work tree, `<root>/repo`. */
  readonly dir: string;
  /** The environment for every process that should see this repository. */
  readonly env: GitEnv;
  /** Run git in the work tree; throws with git's stderr on a non-zero exit. */
  git(...args: string[]): string;
};

/**
 * Create `<root>/home` and `<root>/repo`, then `git init` the repo with a
 * fixture identity. `parentEnv` is the environment the caller would otherwise
 * pass on; its git context is dropped.
 */
export function scratchRepository(
  root: string,
  identity: { name: string; email: string },
  parentEnv: Record<string, string | undefined> = process.env,
): ScratchRepository {
  const home = join(root, "home");
  const dir = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const env = scratchGitEnv(home, parentEnv);
  const git = (...args: string[]): string => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString();
  };
  git("init", "--quiet");
  git("config", "user.email", identity.email);
  git("config", "user.name", identity.name);
  return { dir, env, git };
}
