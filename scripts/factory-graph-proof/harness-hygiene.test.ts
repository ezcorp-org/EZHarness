import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The graph-proof harness runs on a shared host. A prune there is host-wide: `podman image prune`
 * removes every session's dangling layers, including builds that only their owner may remove
 * (the shared-host disk rule). The harness builds no image of its own (the runner stages files into
 * one pinned image), so it has nothing to prune and nothing to remove by tag. This keeps a prune
 * from coming back into any harness file (W10c G9).
 */
const HERE = import.meta.dir;
const PRUNE = /\b(?:podman|docker)\s+(?:image\s+|system\s+|container\s+|volume\s+)?prune\b/;

function harnessFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return harnessFiles(path);
    return /\.(sh|ts|mjs|js)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("the pattern catches every prune form and nothing else", () => {
  for (const line of ["podman image prune -f", "podman system prune -af", "docker image prune", "podman prune", "  podman volume prune --force"]) expect(PRUNE.test(line)).toBe(true);
  for (const line of ["podman rmi localhost/w10c-guest", "podman image ls", "# never run an image-prune here", "pruneOld()"]) expect(PRUNE.test(line)).toBe(false);
});

test("no graph-proof harness file prunes podman or docker storage", () => {
  const files = harnessFiles(HERE);
  expect(files.map((path) => relative(HERE, path))).toContain("run.sh");
  const offenders = files.flatMap((path) => readFileSync(path, "utf8").split("\n").flatMap((line, index) => (PRUNE.test(line) ? [`${relative(HERE, path)}:${index + 1}: ${line.trim()}`] : [])));
  expect(offenders).toEqual([]);
});
