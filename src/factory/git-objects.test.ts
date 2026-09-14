import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FactoryGitObjectError,
  assertFactoryGitPath,
  assertFactoryGitSha,
  factoryGitBlobId,
  factoryGitCommitId,
  factoryGitObjectId,
  factoryGitTreeId,
  type FactoryGitFile,
} from "./git-objects";

/**
 * Real git produced every identity asserted here.
 *
 * The fixture below was created with `git init`, three files, and one commit at a fixed author and
 * committer date; the recorded hashes are what `git hash-object`, `git rev-parse HEAD^{tree}`, and
 * `git rev-parse HEAD` printed. A second live comparison runs against a freshly built repository,
 * so the expectations cannot drift from the tool they model.
 */
const FILES: readonly FactoryGitFile[] = [
  { path: "a.txt", mode: "100644", content: new TextEncoder().encode("hello\n") },
  { path: "dir/b.txt", mode: "100644", content: new TextEncoder().encode("nested\n") },
  // `dir-two.txt` sorts before `dir/b.txt` only if the directory key carries its trailing slash.
  { path: "dir-two.txt", mode: "100644", content: new TextEncoder().encode("x") },
];
const BLOB_A = "ce013625030ba8dba906f756967f9e9ca394464a";
const TREE = "5964f4a4191abac949416a6c45fddaa54b3f9a20";
const COMMIT = "ba63a3699ca16f845eeb8c05af3e8322eadc0f38";
const IDENTITY = { name: "EZCorp", email: "e@z.invalid", atSeconds: 1_700_000_000, timezone: "+0000" } as const;

let repository: string;
const GIT_ENV = {
  PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: `${IDENTITY.atSeconds} ${IDENTITY.timezone}`,
  GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: `${IDENTITY.atSeconds} ${IDENTITY.timezone}`,
};

async function git(...argv: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...argv], { cwd: repository, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${argv[0]} failed`);
  return stdout.trim();
}

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "ezcorp-git-objects-"));
  await git("init", "-q", "-b", "main", ".");
  for (const file of FILES) {
    const path = join(repository, file.path);
    await Bun.write(path, file.content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed message");
});

afterAll(async () => { await rm(repository, { recursive: true, force: true }); });

test("a blob identity is the one git computes", async () => {
  expect(factoryGitBlobId(FILES[0]!.content)).toBe(BLOB_A);
  expect(await git("hash-object", "a.txt")).toBe(BLOB_A);
  expect(factoryGitObjectId("blob", new Uint8Array())).toBe(await git("hash-object", "-t", "blob", "/dev/null"));
});

test("a complete tree identity is the one git computes, including the directory sort key", async () => {
  expect(factoryGitTreeId(FILES)).toBe(TREE);
  expect(await git("rev-parse", "HEAD^{tree}")).toBe(TREE);
  // Order of the input list must not matter; the sort key does.
  expect(factoryGitTreeId([...FILES].reverse())).toBe(TREE);
});

test("a commit identity is the one git computes for the same tree, parent, identity, and message", async () => {
  const id = factoryGitCommitId({ treeId: TREE, parents: [], author: IDENTITY, committer: IDENTITY, message: "seed message\n" });
  expect(id).toBe(COMMIT);
  expect(await git("rev-parse", "HEAD")).toBe(COMMIT);
  // A second commit with the recorded parent matches git as well.
  await Bun.write(join(repository, "a.txt"), "changed\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "second message");
  const childTree = await git("rev-parse", "HEAD^{tree}");
  expect(factoryGitCommitId({ treeId: childTree, parents: [COMMIT], author: IDENTITY, committer: IDENTITY, message: "second message\n" })).toBe(await git("rev-parse", "HEAD"));
});

test("an executable file changes the tree, and git agrees", async () => {
  const executable = factoryGitTreeId([{ ...FILES[0]!, mode: "100755" }, FILES[1]!, FILES[2]!]);
  expect(executable).not.toBe(TREE);
  // `update-index --chmod` stages the mode alone; a second `add` would take the worktree mode back.
  await git("update-index", "--chmod=+x", "a.txt");
  await git("commit", "-q", "-m", "executable");
  expect(await git("rev-parse", "HEAD^{tree}")).toBe(factoryGitTreeId([{ ...FILES[0]!, mode: "100755", content: new TextEncoder().encode("changed\n") }, FILES[1]!, FILES[2]!]));
});

test("every path shape a published tree may not contain is refused", () => {
  for (const path of ["", "/absolute", "a\\b", "../escape", "a/../b", "a/./b", "a//b", ".git/config", "nested/.GIT/hook", "a\u0000b", "a\u001fb", "x".repeat(4097)]) {
    let error: unknown = null;
    try { assertFactoryGitPath(path); } catch (cause) { error = cause; }
    expect([path.slice(0, 16), (error as FactoryGitObjectError)?.code]).toEqual([path.slice(0, 16), "factory_git_path_invalid"]);
  }
  expect(assertFactoryGitPath("src/index.ts")).toBe("src/index.ts");
  expect(() => assertFactoryGitPath(7 as unknown as string)).toThrow(FactoryGitObjectError);
});

test("a mode git cannot store in a published tree is refused", () => {
  for (const mode of ["120000", "160000", "040000", "100644 "]) {
    expect(() => factoryGitTreeId([{ path: "a", mode: mode as "100644", content: new Uint8Array() }])).toThrow(FactoryGitObjectError);
  }
});

test("a path that is both a file and a directory is a conflict, not a merge", () => {
  const conflicts: readonly (readonly FactoryGitFile[])[] = [
    [{ path: "a", mode: "100644", content: new Uint8Array() }, { path: "a/b", mode: "100644", content: new Uint8Array() }],
    [{ path: "a/b", mode: "100644", content: new Uint8Array() }, { path: "a", mode: "100644", content: new Uint8Array() }],
    [{ path: "a", mode: "100644", content: new Uint8Array() }, { path: "a", mode: "100644", content: new Uint8Array([1]) }],
  ];
  for (const files of conflicts) {
    let error: unknown = null;
    try { factoryGitTreeId(files); } catch (cause) { error = cause; }
    expect((error as FactoryGitObjectError)?.code).toBe("factory_git_tree_conflict");
  }
});

test("an object identity is forty lowercase hex characters and nothing else", () => {
  expect(assertFactoryGitSha(TREE)).toBe(TREE);
  for (const value of ["", "ZZ", TREE.toUpperCase(), `${TREE}0`, TREE.slice(1), 1 as unknown as string]) {
    expect(() => assertFactoryGitSha(value)).toThrow(FactoryGitObjectError);
  }
});

test("a commit refuses an identity or a message it cannot reproduce", () => {
  const base = { treeId: TREE, parents: [] as readonly string[], author: IDENTITY, committer: IDENTITY, message: "m" };
  for (const commit of [
    { ...base, treeId: "not-a-sha" },
    { ...base, parents: ["not-a-sha"] },
    { ...base, message: "" },
    { ...base, message: "a\u0000b" },
    { ...base, author: { ...IDENTITY, name: "" } },
    { ...base, author: { ...IDENTITY, email: "" } },
    { ...base, author: { ...IDENTITY, name: "a<b" } },
    { ...base, author: { ...IDENTITY, email: "a\nb" } },
    { ...base, committer: { ...IDENTITY, atSeconds: -1 } },
    { ...base, committer: { ...IDENTITY, atSeconds: 1.5 } },
    { ...base, committer: { ...IDENTITY, timezone: "UTC" } },
  ]) {
    expect(() => factoryGitCommitId(commit)).toThrow(FactoryGitObjectError);
  }
});
