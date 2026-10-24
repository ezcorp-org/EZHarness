import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCommandRunner } from "./project-open-pr";
import { readProjectSourcePaths, selectProjectSourceFiles } from "./project-source-files";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("actual Git selects tracked ignored files and native source changes, excludes ignored output and preserves deletions", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-selection-")); roots.push(root);
  const run: ProjectCommandRunner = async (argv, cwd) => {
    const proc = Bun.spawnSync(argv, { cwd, env: { PATH: process.env.PATH ?? "", HOME: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    return { exitCode: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr) };
  };
  expect((await run(["git", "init", "--initial-branch=ezharness-workspace", "--template=", "--", "."], root)).exitCode).toBe(0);
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\ntracked-ignored.txt\n");
  await writeFile(join(root, "tracked-ignored.txt"), "base"); await writeFile(join(root, "deleted.txt"), "base");
  expect((await run(["git", "--literal-pathspecs", "add", "--force", "--", ".gitignore", "tracked-ignored.txt", "deleted.txt"], root)).exitCode).toBe(0);
  await unlink(join(root, "deleted.txt")); await writeFile(join(root, "tracked-ignored.txt"), "native edit");
  await writeFile(join(root, "new source.txt"), "new source");
  for (const path of ["node_modules", "dist"]) { await mkdir(join(root, path)); await writeFile(join(root, path, "generated"), "output"); }
  expect(await selectProjectSourceFiles(run, root)).toEqual([".gitignore", "new source.txt", "tracked-ignored.txt"]);
  expect(await readProjectSourcePaths(run, root, "deleted")).toEqual(["deleted.txt"]);
});

test("NUL output rejects incomplete and empty frames but preserves the legacy caller filename policy", async () => {
  for (const stdout of ["partial", "\0", "a\0\0"]) {
    const run: ProjectCommandRunner = async () => ({ exitCode: 0, stdout, stderr: "" });
    await expect(readProjectSourcePaths(run, ".", "tracked")).rejects.toThrow();
  }
  const legacyNames = ["literal name", "a\\b", "e\u0301.txt", "line\nbreak", ".ezcorp/metadata"];
  const run: ProjectCommandRunner = async () => ({ exitCode: 0, stdout: [...legacyNames, "literal name"].join("\0") + "\0", stderr: "" });
  expect(await readProjectSourcePaths(run, ".", "tracked")).toEqual(legacyNames);
});

test("selector fails on failed Git or an over-bound manifest instead of silently dropping source", async () => {
  const failed: ProjectCommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "failed" });
  await expect(selectProjectSourceFiles(failed, ".")).rejects.toThrow("failed");
  const huge: ProjectCommandRunner = async () => ({ exitCode: 0, stdout: "a".repeat(16 * 1024 * 1024) + "\0", stderr: "" });
  await expect(readProjectSourcePaths(huge, ".", "tracked")).rejects.toThrow("bound");
});
