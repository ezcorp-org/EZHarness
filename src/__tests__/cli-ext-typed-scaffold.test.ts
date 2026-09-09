import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scaffoldExtension, scaffoldWorkspace, EXT_TYPES } from "@ezcorp/sdk/scaffold";

test("actual CLI uses the requested shared scaffold and refuses invalid types before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-typed-cli-"));
  const cli = resolve(import.meta.dir, "../cli.ts");
  const run = async (name: string, options: string[]) => {
    const child = Bun.spawn([process.execPath, cli, "ext", "init", name, ...options], { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    for (const type of [undefined, ...EXT_TYPES]) {
      const name = `scaffold-${type ?? "default"}`;
      const result = await run(name, type === undefined ? [] : ["--type", type]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Created v4 source");
      const expected = type === undefined ? scaffoldWorkspace({ name, description: "A new extension" }) : scaffoldExtension({ name, type, description: "A new extension" });
      const paths = await readdir(join(directory, name), { recursive: true, withFileTypes: true });
      expect(paths.filter(entry => entry.isFile())).toHaveLength(Object.keys(expected.files).length);
      for (const [path, contents] of Object.entries(expected.files)) expect(await readFile(join(directory, name, path), "utf8")).toBe(contents);
    }
    for (const options of [["--type", "untrusted-module"], ["--type"]]) {
      const rejected = await run("invalid-type", options);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("type");
      expect(await readdir(directory)).not.toContain("invalid-type");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
