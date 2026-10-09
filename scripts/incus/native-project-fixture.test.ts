import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fixtureGitEnv } from "../../src/__tests__/helpers/git-fixture-env";

const plan = await Bun.file(join(import.meta.dir, "native-project-fixture.json")).json() as {
  sourceCommit: string; sourceTree: string; image: string;
  files: Record<string, string>; fileSha256: Record<string, string>;
  commands: Record<string, string>; edits: Array<{ path: string; old_string: string; new_string: string }>;
};

test("fixed guest-local origin produces an independent checkout, real failing tests, repair and retained commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "incus-native-fixture-"));
  const env = fixtureGitEnv({ ...process.env, GIT_DIR: "/nonexistent/poisoned-git-dir", GIT_WORK_TREE: "/nonexistent/poisoned-git-worktree" });
  const run = (command: string) => Bun.spawnSync(["bash", "-c", command], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const succeeded = (command: string) => {
    const result = run(command);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    for (const repetition of ["first", "second"]) {
      const directory = join(root, repetition);
      await mkdir(directory);
      const commandRoot = `cd '${directory}' && `;
      succeeded(commandRoot + plan.commands.prepare);
      for (const [name, content] of Object.entries(plan.files)) {
        expect(createHash("sha256").update(content).digest("hex")).toBe(plan.fileSha256[name]);
        await writeFile(join(directory, "g5-origin-source", name), content, { mode: 0o644 });
      }
      succeeded(commandRoot + plan.commands.origin);
      succeeded(commandRoot + plan.commands.checkout);
      expect(succeeded(commandRoot + "git -C g5-native rev-parse HEAD")).toBe(plan.sourceCommit);
      expect(succeeded(commandRoot + "git -C g5-native rev-parse 'HEAD^{tree}'")).toBe(plan.sourceTree);
      expect(succeeded(commandRoot + "git -C g5-native config --get remote.origin.url")).toBe(join(directory, "g5-origin.git"));
      const failing = run(commandRoot + plan.commands.tests);
      expect(failing.exitCode).toBe(1);
      expect(failing.stderr.toString()).toContain("FAIL: test_negative");
      expect(failing.stderr.toString()).toContain("Ran 3 tests");
      expect(succeeded(commandRoot + plan.commands.seedRed)).toBe("G5-SEED-RED:negative-test-confirmed");
      for (const edit of plan.edits) {
        const path = join(directory, edit.path);
        const before = await Bun.file(path).text();
        expect(before.split(edit.old_string)).toHaveLength(2);
        await writeFile(path, before.replace(edit.old_string, edit.new_string));
      }
      const passing = run(commandRoot + plan.commands.tests);
      expect(passing.exitCode, passing.stderr.toString()).toBe(0);
      expect(passing.stderr.toString()).toContain("Ran 3 tests");
      expect(passing.stderr.toString()).toContain("OK");
      const commit = succeeded(commandRoot + plan.commands.commit).split("\n").at(-1)!;
      expect(commit).toMatch(/^[a-f0-9]{40}$/);
      expect(commit).not.toBe(plan.sourceCommit);
      expect(succeeded(commandRoot + plan.commands.retained)).toBe(commit);
      expect(await Bun.file(join(directory, "g5-native", "proof.txt")).text()).toBe("stage=after\n");
      const repeated = run(commandRoot + plan.commands.prepare);
      expect(repeated.exitCode).not.toBe(0);
      expect(succeeded(commandRoot + "git -C g5-native rev-parse HEAD")).toBe(commit);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("Compose consumes this checkout through a read-only mount and pinned cached image", () => {
  const compose = parse(plan.files["compose.yaml"]!) as { services: Record<string, Record<string, unknown>> };
  expect(Object.keys(compose.services)).toEqual(["proof"]);
  const proof = compose.services.proof!;
  expect(proof.image).toBe(plan.image);
  expect(plan.image).toMatch(/^docker\.io\/library\/busybox@sha256:[a-f0-9]{64}$/);
  expect(proof.pull_policy).toBe("never");
  expect(proof.volumes).toEqual([{ type: "bind", source: ".", target: "/fixture", read_only: true }]);
  expect(proof.read_only).toBe(true);
  expect(proof.network_mode).toBe("none");
  expect(proof.cap_drop).toEqual(["ALL"]);
  expect(proof.security_opt).toEqual(["no-new-privileges:true"]);
  expect(proof).not.toHaveProperty("privileged");
  expect(proof).not.toHaveProperty("ports");
  expect(proof.healthcheck).toMatchObject({ test: ["CMD", "sh", "-c", "grep -qx stage=after /fixture/proof.txt"] });
});
