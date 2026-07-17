import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLandlockAbi } from "../../../../../src/extensions/sandbox/capability-probe";
import { defaultShimPath } from "../../../../../src/extensions/sandbox/build-sandbox-argv";
import {
  buildJailInvocation,
  jailGitIdentityEnv,
  jailRwPaths,
  localUpstreamPath,
  makeJailedShell,
  BOT_GIT_NAME,
  BOT_GIT_EMAIL,
  RAW_SPEC_ENV,
} from "./jail";

describe("jailRwPaths", () => {
  test("grants the worktree + gate dir + /dev, never the project root", () => {
    expect(jailRwPaths("/wt", "/gate.git")).toEqual(["/wt", "/gate.git", "/dev"]);
  });
  test("appends extra grants (a local-file upstream) after the fixed set", () => {
    expect(jailRwPaths("/wt", "/gate.git", ["/up.git"])).toEqual(["/wt", "/gate.git", "/dev", "/up.git"]);
  });
});

describe("localUpstreamPath", () => {
  test("bare absolute path → granted (self-hosted local gate upstream)", () => {
    expect(localUpstreamPath("/app/projects/ecf-demo-upstream.git")).toBe(
      "/app/projects/ecf-demo-upstream.git",
    );
  });
  test("file:// URL → the path is granted", () => {
    expect(localUpstreamPath("file:///srv/up.git")).toBe("/srv/up.git");
  });
  test("network remotes → null (over the wire, no fs grant)", () => {
    expect(localUpstreamPath("https://github.com/o/r.git")).toBeNull();
    expect(localUpstreamPath("ssh://git@github.com/o/r.git")).toBeNull();
    expect(localUpstreamPath("git@github.com:o/r.git")).toBeNull();
    expect(localUpstreamPath("git://host/r.git")).toBeNull();
  });
  test("empty / relative / non-absolute file URL → null (fail-safe: no grant)", () => {
    expect(localUpstreamPath("")).toBeNull();
    expect(localUpstreamPath("  ")).toBeNull();
    expect(localUpstreamPath("relative/up.git")).toBeNull();
    expect(localUpstreamPath("file://relative")).toBeNull();
  });
});

describe("jailGitIdentityEnv", () => {
  test("sets a config-free bot identity for author AND committer (hermetic git)", () => {
    // The jailed git pins GIT_CONFIG_GLOBAL=/dev/null, so without these a
    // `git commit` aborts "Author identity unknown".
    expect(jailGitIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: BOT_GIT_NAME,
      GIT_AUTHOR_EMAIL: BOT_GIT_EMAIL,
      GIT_COMMITTER_NAME: BOT_GIT_NAME,
      GIT_COMMITTER_EMAIL: BOT_GIT_EMAIL,
    });
  });
});

// The PURE assembly seam — the whole reason jail.ts no longer imports the
// host sandbox builders (their static node:fs dies under the subprocess
// poisoning; drive-3's push-step blocker). Tier + shim path come from the
// host-baked env handoff.
describe("buildJailInvocation (pure assembly)", () => {
  const CMD = ["git", "push", "origin", "HEAD:refs/heads/x"] as const;

  test("landlock tier + shim → bun-shim argv with the RAW spec env", () => {
    const inv = buildJailInvocation(
      CMD, "/wt", "/gate.git", "/proj",
      { EZCORP_SANDBOX_TIER: "landlock", EZCORP_SANDBOX_SHIM: "/shim.ts" },
      "/usr/local/bin/bun",
    );
    expect(inv.jailed).toBe(true);
    expect(inv.argv).toEqual(["/usr/local/bin/bun", "/shim.ts", "--", ...CMD]);
    const raw = JSON.parse(inv.env[RAW_SPEC_ENV]!);
    // Workspace = the worktree; extra rw = gate repo + /dev; the project root
    // rides ONLY as the forbidden-data anchor, never a grant.
    expect(raw).toEqual({
      workspaceDir: "/wt",
      projectRoot: "/proj",
      rwPaths: ["/gate.git", "/dev"],
    });
  });

  test("bwrap tier ALSO rides the landlock shim (fs-free downgrade)", () => {
    const inv = buildJailInvocation(
      CMD, "/wt", "/g", "/p",
      { EZCORP_SANDBOX_TIER: "bwrap", EZCORP_SANDBOX_SHIM: "/shim.ts" },
      "bun",
    );
    expect(inv.jailed).toBe(true);
    expect(inv.argv.slice(0, 3)).toEqual(["bun", "/shim.ts", "--"]);
  });

  test("extraRwPaths (a local upstream) is appended to the RAW spec rw set", () => {
    const inv = buildJailInvocation(
      CMD, "/wt", "/gate.git", "/proj",
      { EZCORP_SANDBOX_TIER: "landlock", EZCORP_SANDBOX_SHIM: "/shim.ts" },
      "bun",
      ["/up.git"],
    );
    const raw = JSON.parse(inv.env[RAW_SPEC_ENV]!);
    expect(raw.rwPaths).toEqual(["/gate.git", "/dev", "/up.git"]);
  });

  test("advisory tier → plain passthrough (no shim, no env)", () => {
    const inv = buildJailInvocation(
      CMD, "/wt", "/g", "/p",
      { EZCORP_SANDBOX_TIER: "advisory", EZCORP_SANDBOX_SHIM: "/shim.ts" },
      "bun",
    );
    expect(inv).toEqual({ argv: [...CMD], env: {}, jailed: false });
  });

  test("missing handoff (no tier / no shim) → plain passthrough", () => {
    expect(buildJailInvocation(CMD, "/wt", "/g", "/p", {}, "bun").jailed).toBe(false);
    expect(
      buildJailInvocation(CMD, "/wt", "/g", "/p", { EZCORP_SANDBOX_TIER: "landlock" }, "bun").jailed,
    ).toBe(false);
  });
});

describe("makeJailedShell (origin resolution fail-safe)", () => {
  test("a THROWING origin lookup (git missing) → no extra grant, command still runs", async () => {
    // Bun.spawn throws synchronously on a missing binary; the resolver's
    // catch must degrade to "no local-upstream grant" — never break the
    // shell. Spy the FIRST spawn (the `git remote get-url origin` probe) to
    // throw, pass every later call through to the real spawn.
    const realSpawn = Bun.spawn.bind(Bun);
    let first = true;
    const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (first) {
        first = false;
        throw new Error("posix_spawn 'git': ENOENT");
      }
      return realSpawn(...args);
    }) as typeof Bun.spawn);
    try {
      const shell = makeJailedShell("/nonexistent-gate.git", "/proj");
      const r = await shell(["/bin/sh", "-c", "echo NO_GRANT_OK"], "/tmp");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("NO_GRANT_OK");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("makeJailedShell (ambient tier)", () => {
  test("threads cmd + cwd through the jail and returns a ShellResult", async () => {
    // Mirror production: a worktree workspace + a gate bare repo + a project
    // root whose `.ezcorp/data` is the forbidden anchor. Without the env
    // handoff this is a plain spawn; with it the jail may alter the exit —
    // the command + wiring are exercised either way. The repo root is NEVER
    // granted, so the builder's data-dir assertion passes.
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

// Real containment (read AND write, realpath-based) through the REAL shim —
// the exact production invocation shape the subprocess assembles from the env
// handoff. Landlock applies in the shim regardless of the host's SELECTED
// tier (a bwrap host is landlock-usable by definition), so gate only on the
// kernel: runs on the landlock-capable dev host AND in-container CI.
describe("makeJailedShell (landlock containment via the real shim)", () => {
  const savedTier = process.env.EZCORP_SANDBOX_TIER;
  const savedShim = process.env.EZCORP_SANDBOX_SHIM;
  afterEach(() => {
    if (savedTier === undefined) delete process.env.EZCORP_SANDBOX_TIER;
    else process.env.EZCORP_SANDBOX_TIER = savedTier;
    if (savedShim === undefined) delete process.env.EZCORP_SANDBOX_SHIM;
    else process.env.EZCORP_SANDBOX_SHIM = savedShim;
  });

  test.if((probeLandlockAbi() ?? 0) >= 1)(
    "jailed git commits into the gate repo; project .ezcorp/data is DENIED read AND write",
    async () => {
      // The host-baked env handoff, exactly as buildSpawnEnv() sets it.
      process.env.EZCORP_SANDBOX_TIER = "landlock";
      process.env.EZCORP_SANDBOX_SHIM = defaultShimPath();

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

      // A LOCAL bare UPSTREAM (the self-hosted gate's `origin` — a stand-in for
      // GitHub), OUTSIDE the project. The gate's origin points at it, so the
      // jailed push must reach it — makeJailedShell grants it because it's a
      // local path. It lives under a SEPARATE base so it is not covered by any
      // project/gate grant; only the origin-resolved grant reaches it.
      const upRoot = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-up-")));
      const upstream = join(upRoot, "upstream.git");
      run(["git", "init", "--bare", "-b", "main", upstream], upRoot);
      run(["git", "push", upstream, "HEAD:refs/heads/main"], seed);
      run(["git", "-C", gate, "remote", "add", "origin", upstream], gate);

      // Materialize a detached worktree OUTSIDE the project (TMPDIR-like).
      const wtRoot = realpathSync(mkdtempSync(join(tmpdir(), "ezcf-wt-")));
      const wt = join(wtRoot, "wt");
      run(["git", "-C", gate, "worktree", "add", "--detach", wt, "main"], gate);
      writeFileSync(join(wt, "feature.txt"), "agent work\n");

      const jailed = makeJailedShell(gate, project);
      try {
        // NO `git config user.*` first — the jailed git is hermetic
        // (GIT_CONFIG_GLOBAL=/dev/null) and gets its identity from the
        // GIT_AUTHOR_*/GIT_COMMITTER_* env jailGitIdentityEnv injects. A commit
        // that succeeds here proves that path (before the fix it aborted
        // "Author identity unknown").
        expect((await jailed(["git", "add", "-A"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "commit", "-m", "jailed work"], wt)).exitCode).toBe(0);

        // The commit's objects landed in the SHARED gate repo — git FUNCTIONED
        // jailed without the project root. Read the worktree's detached HEAD
        // (whose tree now carries feature.txt) back from that shared object store.
        const tree = run(["git", "-C", wt, "ls-tree", "-r", "--name-only", "HEAD"], wt)
          .stdout.toString();
        expect(tree).toContain("feature.txt");
        // Authored + committed under the config-free bot identity.
        const author = run(["git", "-C", wt, "log", "-1", "--format=%an <%ae>|%cn <%ce>"], wt)
          .stdout.toString().trim();
        expect(author).toBe(`${BOT_GIT_NAME} <${BOT_GIT_EMAIL}>|${BOT_GIT_NAME} <${BOT_GIT_EMAIL}>`);

        // The jailed push REACHES the local upstream (makeJailedShell resolved
        // the gate's origin → a local path → granted it in the jail). Before
        // this grant the file-transport push EACCES'd ("does not appear to be a
        // git repository") — the exact drive-4 push-step failure.
        const pushed = await jailed(["git", "push", "origin", "HEAD:refs/heads/feat/x"], wt);
        expect(pushed.exitCode).toBe(0);
        const upTip = run(["git", "-C", upstream, "rev-parse", "refs/heads/feat/x"], upstream)
          .stdout.toString().trim();
        const wtHead = run(["git", "-C", wt, "rev-parse", "HEAD"], wt).stdout.toString().trim();
        expect(upTip).toBe(wtHead);

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
        rmSync(upRoot, { recursive: true, force: true });
        rmSync(seed, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
    // Real landlock-jailed subprocess work (init/clone/commit/push/worktree +
    // several jailed git invocations) genuinely takes ~6s — above bun's 5s
    // default. An explicit timeout keeps it from flaking under load / coverage.
    30000,
  );
});
