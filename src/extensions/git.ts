/**
 * Git operation wrappers with timeout handling.
 *
 * Thin layer over Bun.spawnSync for git commands used by the extension installer.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;

export function gitExec(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): GitResult {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: opts?.cwd,
      timeout,
      env: { ...process.env },
    });

    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stdout: "",
      stderr: message,
      exitCode: 128,
    };
  }
}

export function clone(
  url: string,
  dest: string,
  opts?: { depth?: number; branch?: string },
): GitResult {
  const args = ["clone"];
  if (opts?.depth) args.push("--depth", String(opts.depth));
  if (opts?.branch) args.push("--branch", opts.branch);
  args.push(url, dest);

  return gitExec(args, { timeout: CLONE_TIMEOUT_MS });
}

export function lsRemoteTags(url: string): string[] {
  const result = gitExec(["ls-remote", "--tags", url], {
    timeout: CLONE_TIMEOUT_MS,
  });

  if (!result.ok || !result.stdout) return [];

  return result.stdout
    .split("\n")
    .filter((line) => !line.includes("^{}")) // filter deref lines
    .map((line) => {
      const refPath = line.split("\t")[1];
      return refPath?.replace("refs/tags/", "") ?? "";
    })
    .filter(Boolean);
}

export function getCurrentRef(repoDir: string): string {
  const result = gitExec(["rev-parse", "HEAD"], { cwd: repoDir });
  if (!result.ok) {
    throw new Error(`Failed to get HEAD ref: ${result.stderr}`);
  }
  return result.stdout;
}
