import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRefFormatError, MAX_GIT_BRANCH_LENGTH, assertGitBranchName, gitHeadRef, isValidGitBranchName } from "./project-git-refs";

let repository: string;
const GIT_ENV = {
  PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent",
  GIT_AUTHOR_NAME: "EZCorp", GIT_AUTHOR_EMAIL: "extensions@ezcorp.invalid",
  GIT_COMMITTER_NAME: "EZCorp", GIT_COMMITTER_EMAIL: "extensions@ezcorp.invalid",
};

beforeAll(async () => {
  // `git check-ref-format --branch` resolves `@`-style shorthands, so it needs a repository.
  repository = await mkdtemp(join(tmpdir(), "ezcorp-ref-format-"));
  await Bun.spawn(["git", "init", "-q", "-b", "main", repository], { cwd: repository, env: GIT_ENV, stdout: "ignore", stderr: "ignore" }).exited;
  // One commit, so `@` has something to resolve to and the HEAD-alias claim is testable.
  await Bun.spawn(["git", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: repository, env: GIT_ENV, stdout: "ignore", stderr: "ignore" }).exited;
});

afterAll(async () => { await rm(repository, { recursive: true, force: true }); });

async function git(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const child = Bun.spawn(["git", ...argv], { cwd: repository, env: GIT_ENV, stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { exitCode, stdout: stdout.trim() };
}

/** The oracle for the bulk of the grammar: is `refs/heads/<branch>` a well-formed ref? */
async function gitRefAccepts(branch: string): Promise<boolean> {
  return (await git(["check-ref-format", `refs/heads/${branch}`])).exitCode === 0;
}

const VALID = [
  "main",
  "ez-code/run-1",
  `ezcorp-factory/factory-release%3A${"a".repeat(64)}`,
  "feature/nested/deep",
  "a",
  "release_1.2",
  "v1.0.0",
  "x".repeat(MAX_GIT_BRANCH_LENGTH),
] as const;

/** Refused here, and git refuses the same ref. */
const INVALID_LIKE_GIT: readonly (readonly [string, string])[] = [
  ["", "empty"],
  ["a..b", "a doubled dot"],
  ["a b", "a space"],
  ["a\u0009b", "a tab"],
  ["a\u007fb", "a delete character"],
  ["a~b", "a tilde"],
  ["a^b", "a caret"],
  ["a:b", "a colon, which every factory operation id contains"],
  ["a?b", "a question mark"],
  ["a*b", "an asterisk"],
  ["a[b", "an open bracket"],
  ["a\\b", "a backslash"],
  ["a@{b", "an at-brace"],
  ["/leading", "a leading slash"],
  ["trailing/", "a trailing slash"],
  ["double//slash", "a repeated slash"],
  ["trailing.", "a trailing dot"],
  [".hidden", "a leading dot"],
  ["nested/.hidden", "a component starting with a dot"],
  ["thing.lock", "a .lock suffix"],
  ["nested/thing.lock", "a component ending in .lock"],
];

/** Refused here for a stated reason git's plain ref check does not cover. */
const NUL = "a\u0000b";
const TOO_LONG = "x".repeat(MAX_GIT_BRANCH_LENGTH + 1);

test("every accepted name is a ref git itself accepts", async () => {
  for (const branch of VALID) {
    expect(isValidGitBranchName(branch)).toBe(true);
    expect([branch, await gitRefAccepts(branch)]).toEqual([branch, true]);
  }
});

test("each shape refused for git's own reason is named, and git refuses it too", async () => {
  for (const [branch, reason] of INVALID_LIKE_GIT) {
    expect([reason, isValidGitBranchName(branch)]).toEqual([reason, false]);
    expect([reason, await gitRefAccepts(branch)]).toEqual([reason, false]);
  }
});

test("a NUL is refused here and cannot even be put to git", () => {
  expect(isValidGitBranchName(NUL)).toBe(false);
  // argv carries no NUL, so there is no way to ask git about this name at all.
  expect(() => Bun.spawn(["git", "check-ref-format", `refs/heads/${NUL}`], { cwd: repository, stdout: "ignore", stderr: "ignore" })).toThrow();
});

test("the length cap is this repository's, because a loose ref is a filename", async () => {
  expect(isValidGitBranchName(TOO_LONG)).toBe(false);
  expect(await gitRefAccepts(TOO_LONG)).toBe(true);
  expect(await gitRefAccepts("x".repeat(4096))).toBe(true);
});

test("a leading dash is refused here and by git's own branch shorthand", async () => {
  expect(isValidGitBranchName("-dash")).toBe(false);
  // The plain ref check accepts it, so only the branch shorthand shows the hazard: there is no
  // `--` terminator for `check-ref-format`, and the name is read as an option.
  expect(await gitRefAccepts("-dash")).toBe(true);
  expect((await git(["check-ref-format", "--branch", "-dash"])).exitCode).toBe(128);
  expect(await git(["check-ref-format", "--branch", "dash"])).toEqual({ exitCode: 0, stdout: "dash" });
});

test("the bare at sign is refused here because git's revision syntax reads it as HEAD", async () => {
  expect(isValidGitBranchName("@")).toBe(false);
  // `refs/heads/@` is a well-formed ref, so only the revision syntax shows why a branch may not
  // be named `@`: it already means HEAD, so the name could never select the branch.
  expect(await gitRefAccepts("@")).toBe(true);
  expect(await git(["rev-parse", "--symbolic-full-name", "@"])).toEqual({ exitCode: 0, stdout: "refs/heads/main" });
  const [alias, head] = await Promise.all([git(["rev-parse", "@"]), git(["rev-parse", "HEAD"])]);
  expect(alias).toEqual(head);
});

test("a non-string is not a branch name", () => {
  for (const value of [undefined, null, 42, {}, ["main"]]) expect(isValidGitBranchName(value)).toBe(false);
});

test("the throwing form names the branch it refused and the passing form returns it", () => {
  expect(assertGitBranchName("ez-code/run-1")).toBe("ez-code/run-1");
  let error: unknown = null;
  try { assertGitBranchName("a:b"); } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(GitRefFormatError);
  expect((error as GitRefFormatError).branch).toBe("a:b");
  expect((error as Error).name).toBe("GitRefFormatError");
});

test("the head ref is built only from a proved branch", () => {
  expect(gitHeadRef("ezcorp-factory/x")).toBe("refs/heads/ezcorp-factory/x");
  expect(() => gitHeadRef("bad name")).toThrow(GitRefFormatError);
});
