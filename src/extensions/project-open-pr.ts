import { mkdtemp, rm, mkdir, copyFile, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProjectPullRequestInput {
  projectRoot: string;
  runId: string;
  title: string;
  body: string;
}

export interface ProjectCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProjectCommandRunner = (argv: string[], cwd: string, input?: string) => Promise<ProjectCommandResult>;

export interface ProjectPullRequestOptions {
  githubToken?: string;
  run?: ProjectCommandRunner;
}

const GIT_POLICY = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "http.followRedirects=false"];
const FORBIDDEN_CONFIG = /^(?:include(?:if)?\.|filter\.|http\.|protocol\.|gpg\.|extensions\.worktreeconfig|core\.(?:sshcommand|gitproxy|alternaterefscommand)|diff\..*\.(?:command|textconv)|remote\..*\.(?:uploadpack|receivepack|proxy)|url\.)/i;
const MAX_OUTPUT = 16 * 1024 * 1024;

function createRunner(githubToken?: string): ProjectCommandRunner {
  return async (argv, cwd, input) => {
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "EZCorp",
      GIT_AUTHOR_EMAIL: "extensions@ezcorp.invalid",
      GIT_COMMITTER_NAME: "EZCorp",
      GIT_COMMITTER_EMAIL: "extensions@ezcorp.invalid",
    };
    if (githubToken) {
      environment.GH_TOKEN = githubToken;
      environment.GIT_CONFIG_COUNT = "1";
      environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      environment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`;
    }
    const command = argv[0] === "git" ? ["git", ...GIT_POLICY, ...argv.slice(1)] : argv;
    const child = Bun.spawn(command, { cwd, env: environment, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    async function bounded(stream: ReadableStream<Uint8Array>): Promise<string> {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > MAX_OUTPUT) { child.kill("SIGKILL"); throw new Error("Project command output limit exceeded"); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function openProjectPullRequest(input: ProjectPullRequestInput, options: ProjectPullRequestOptions = {}): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.runId) || input.runId.includes("..") || !input.title.trim() || input.title.length > 500 || input.body.length > 100_000) return { ok: false, error: "Invalid pull request input" };
  const projectRoot = await realpath(input.projectRoot);
  const run = options.run ?? createRunner(options.githubToken);
  async function checked(argv: string[], cwd = projectRoot, stdin?: string): Promise<string> {
    const result = await run(argv, cwd, stdin);
    if (result.exitCode !== 0) throw new Error(`${argv[0]} ${argv[1]} failed (exit ${result.exitCode})`);
    return result.stdout;
  }
  let temporaryRoot: string | undefined;
  let worktree: string | undefined;
  try {
    const config = await checked(["git", "config", "--local", "--no-includes", "--name-only", "--list"]);
    if (config.split("\n").some((key) => FORBIDDEN_CONFIG.test(key))) throw new Error("Repository command hooks, filters, or indirect configuration require removal before opening a pull request");
    const remote = (await checked(["git", "remote", "get-url", "origin"])).trim();
    const remoteMatch = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
    if (!remoteMatch) throw new Error("Pull requests require an exact github.com origin");
    const repository = remoteMatch[1]!;
    const branch = `ez-code/${input.runId}`;
    const baseResult = await run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], projectRoot);
    const base = baseResult.exitCode === 0 ? baseResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "main";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(base) || base.includes("..")) throw new Error("Invalid default branch");
    const tracked = (await checked(["git", "ls-files", "-z"])).split("\0").filter(Boolean);
    if (tracked.some((path) => path.split("/").includes(".ezcorp"))) throw new Error("Platform data must not be tracked in the project");
    temporaryRoot = await mkdtemp(join(tmpdir(), "ezcorp-pr-"));
    worktree = join(temporaryRoot, "worktree");
    await checked(["git", "worktree", "add", "--detach", worktree, "HEAD"]);
    const patch = await checked(["git", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--binary"]);
    if (patch) await checked(["git", "apply", "--index", "--whitespace=nowarn", "-"], worktree, patch);
    const untracked = (await checked(["git", "ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of untracked) {
      if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === ".ezcorp")) throw new Error("Unsafe untracked file path");
      const source = await realpath(join(projectRoot, path));
      if (!source.startsWith(projectRoot + sep) || !(await lstat(join(projectRoot, path))).isFile()) throw new Error("Untracked files must be regular project files");
      const target = resolve(worktree, path);
      if (relative(worktree, target).startsWith("..")) throw new Error("File escaped pull request worktree");
      let directory = worktree;
      for (const component of relative(worktree, dirname(target)).split(sep).filter(Boolean)) {
        directory = join(directory, component);
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        if (!(await lstat(directory)).isDirectory()) throw new Error("Worktree directory escaped through a link");
      }
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }
    await checked(["git", "switch", "-c", branch], worktree);
    await checked(["git", "add", "-A"], worktree);
    await checked(["git", "commit", "-m", input.title], worktree);
    await checked(["git", "push", `https://github.com/${repository}.git`, `HEAD:refs/heads/${branch}`], worktree);
    const url = (await checked(["gh", "pr", "create", "--repo", repository, "--base", base, "--head", branch, "--title", input.title, "--body", input.body], worktree)).trim();
    if (!/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/\d+$/.test(url)) throw new Error("Pull request creation returned an invalid URL");
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (worktree) await run(["git", "worktree", "remove", "--force", worktree], projectRoot).catch(() => undefined);
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
