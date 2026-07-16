import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSandboxTier, probeLandlockAbi } from "../../../../../src/extensions/sandbox/capability-probe";
import { jailRwPaths, makeJailedShell } from "./jail";

describe("jailRwPaths", () => {
  test("grants the worktree + gate dir + /dev, never the project root", () => {
    expect(jailRwPaths("/wt", "/gate.git")).toEqual(["/wt", "/gate.git", "/dev"]);
  });
});

describe("makeJailedShell (ambient tier)", () => {
  test("threads cmd + cwd through the jail and returns a ShellResult", async () => {
    // Mirror production: a worktree workspace + a gate bare repo + a project
    // root whose `.ezcorp/data` is the forbidden anchor. On a host without a
    // usable OS tier this is a plain spawn; on a capable host the jail may
    // alter the exit — the command + wiring are exercised either way. The repo
    // root is NEVER granted, so the builder's data-dir assertion passes.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-jail-")));
    const repo = join(base, "repo");
    const gate = join(base, "repo", ".ezcorp", "extension-data", "ez-code-factory", "gate.git");
    const wt = join(base, "wt");
    mkdirSync(gate, { recursive: true });
    mkdirSync(wt, { recursive: true });
    try {
      const shell = makeJailedShell(gate, repo);
      const r = await shell(["/bin/sh", "-c", "echo JAIL_OK"], wt);
      expect(typeof r.exitCode).toBe("number");
      expect(typeof r.stdout).toBe("string");
      expect(typeof r.stderr).toBe("string");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// Real containment (read AND write, realpath-based). Landlock is the container's
// production tier and works unprivileged in-process; the dev host resolves to
// bwrap (setuid wrapper rejects unprivileged tmpfs flags), so this runs
// in-container. Skipped elsewhere; the ambient-tier test above covers the code.
describe("makeJailedShell (landlock containment)", () => {
  test.if(getSandboxTier() === "landlock" && (probeLandlockAbi() ?? 0) >= 1)(
    "jailed git commits into the gate repo; project .ezcorp/data is DENIED read AND write",
    async () => {
      const run = (args: string[], cwd: string) =>
        Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });

      const base = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-jail-c-")));
      const project = join(base, "project");
      mkdirSync(project, { recursive: true });
      // A gate BARE repo under the project's extension-data (its real home).
      const gate = join(project, ".ezcorp", "extension-data", "ez-code-factory", "repos", "g.git");
      mkdirSync(gate, { recursive: true });
      run(["git", "init", "--bare", "-b", "main", gate], gate);
      run(["git", "config", "user.email", "t@t.com"], gate);
      run(["git", "config", "user.name", "t"], gate);
      run(["git", "config", "commit.gpgsign", "false"], gate);
      // Seed one commit so the bare repo has a HEAD to branch a worktree from.
      const seed = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-seed-")));
      run(["git", "clone", gate, seed], seed);
      run(["git", "config", "user.email", "t@t.com"], seed);
      run(["git", "config", "user.name", "t"], seed);
      run(["git", "config", "commit.gpgsign", "false"], seed);
      writeFileSync(join(seed, "README.md"), "# seed\n");
      run(["git", "add", "-A"], seed);
      run(["git", "commit", "-m", "seed"], seed);
      run(["git", "push", "origin", "HEAD:refs/heads/main"], seed);

      // Plant the platform secret under the project's .ezcorp/data (a SIBLING of
      // extension-data — never granted).
      const dataDir = join(project, ".ezcorp", "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "jwt"), "TOP-SECRET");

      // Materialize a detached worktree OUTSIDE the project (TMPDIR-like).
      const wtRoot = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-wt-")));
      const wt = join(wtRoot, "wt");
      run(["git", "-C", gate, "worktree", "add", "--detach", wt, "main"], gate);
      writeFileSync(join(wt, "feature.txt"), "agent work\n");

      const jailed = makeJailedShell(gate, project);
      try {
        expect((await jailed(["git", "config", "user.email", "t@t.com"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "config", "user.name", "t"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "add", "-A"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "commit", "-m", "jailed work"], wt)).exitCode).toBe(0);

        // The commit's objects landed in the SHARED gate repo — git FUNCTIONED
        // jailed without the project root. Read the worktree's detached HEAD
        // (whose tree now carries feature.txt) back from that shared object store.
        const tree = run(["git", "-C", wt, "ls-tree", "-r", "--name-only", "HEAD"], wt)
          .stdout.toString();
        expect(tree).toContain("feature.txt");

        // READ of the project's .ezcorp/data/jwt is DENIED (root never granted).
        const readDeny = await jailed(["cat", join(dataDir, "jwt")], wt);
        expect(readDeny.exitCode).not.toBe(0);
        expect(readDeny.stderr.toLowerCase()).toContain("permission denied");

        // WRITE into the project's .ezcorp/data is DENIED too.
        const writeDeny = await jailed(
          ["/bin/sh", "-c", `printf x > ${join(dataDir, "leak")}`],
          wt,
        );
        expect(writeDeny.exitCode).not.toBe(0);
      } finally {
        run(["git", "-C", gate, "worktree", "remove", "--force", wt], gate);
        rmSync(wtRoot, { recursive: true, force: true });
        rmSync(seed, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
