import type { ProjectCommandRunner } from "./project-open-pr";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export type ProjectSourceList = "tracked" | "untracked" | "deleted";

/** Shared tracked/untracked source policy. NUL framing preserves literal filenames. */
export async function readProjectSourcePaths(run: ProjectCommandRunner, root: string, kind: ProjectSourceList): Promise<string[]> {
  const argv = ["git", "ls-files", ...(kind === "untracked" ? ["--others", "--exclude-standard"] : kind === "deleted" ? ["--deleted"] : []), "-z"];
  const result = await run(argv, root);
  if (result.exitCode !== 0) throw new Error("Git source selection failed");
  if (Buffer.byteLength(result.stdout) > MAX_MANIFEST_BYTES || (result.stdout !== "" && !result.stdout.endsWith("\0"))) {
    throw new Error("Git source selection is truncated or exceeds its bound");
  }
  const paths = result.stdout === "" ? [] : result.stdout.slice(0, -1).split("\0");
  if (paths.some(path => path === "")) throw new Error("Git source selection contains an empty path frame");
  return [...new Set(paths)];
}

/** Tracked ignored files stay selected; tracked deletions stay absent. */
export async function selectProjectSourceFiles(run: ProjectCommandRunner, root: string): Promise<string[]> {
  const tracked = await readProjectSourcePaths(run, root, "tracked");
  const untracked = await readProjectSourcePaths(run, root, "untracked");
  const deleted = new Set(await readProjectSourcePaths(run, root, "deleted"));
  return [...new Set([...tracked, ...untracked])].filter(path => !deleted.has(path)).sort();
}
