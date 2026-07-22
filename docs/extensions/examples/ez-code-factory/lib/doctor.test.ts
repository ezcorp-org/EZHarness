import { test, expect, describe } from "bun:test";
import { runDoctor, type DoctorDeps } from "./doctor";
import { HOOK_MARKER } from "./gate";
import type { ShellRunner } from "./shell";
import type { GhRunner } from "./github";
import type { SweepHeartbeat } from "./sweep";

interface ShellOpts {
  bare?: boolean;
  hook?: "managed" | "foreign" | "missing";
  origin?: string | null;
  /** `test -s <credentialPath>` — default present (non-empty). */
  credential?: "present" | "missing";
  /** `sh -c command -v curl` — default present. */
  curl?: "present" | "missing";
  /** `git ls-remote --heads origin <branch>` — default reachable. */
  lsRemote?: "ok" | "fail";
}

function makeRun(opts: ShellOpts): ShellRunner {
  return async (cmd) => {
    const s = cmd.join(" ");
    if (s.includes("rev-parse --is-bare-repository")) {
      return opts.bare === false
        ? { exitCode: 128, stdout: "", stderr: "not a git repository" }
        : { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (cmd[0] === "cat") {
      if (opts.hook === "missing") return { exitCode: 1, stdout: "", stderr: "no such file" };
      if (opts.hook === "foreign") return { exitCode: 0, stdout: "#!/bin/sh\necho custom\n", stderr: "" };
      return { exitCode: 0, stdout: `#!/bin/sh\n# ${HOOK_MARKER}\n`, stderr: "" };
    }
    if (cmd[0] === "test" && cmd[1] === "-s") {
      return opts.credential === "missing"
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    }
    if (s === "sh -c command -v curl") {
      return opts.curl === "missing"
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "/usr/bin/curl\n", stderr: "" };
    }
    if (s.includes("ls-remote")) {
      return opts.lsRemote === "fail"
        ? { exitCode: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" }
        : { exitCode: 0, stdout: "deadbeef\trefs/heads/main\n", stderr: "" };
    }
    if (s.includes("remote get-url origin")) {
      const url = opts.origin === undefined ? "https://github.com/o/r.git" : opts.origin;
      return url ? { exitCode: 0, stdout: `${url}\n`, stderr: "" } : { exitCode: 2, stdout: "", stderr: "no such remote" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function makeGh(exit: number): GhRunner {
  return async () => ({ exitCode: exit, stdout: "", stderr: "" });
}

const heartbeat: SweepHeartbeat = {
  ranAt: "2026-07-16T00:00:00.000Z",
  summary: { scanned: 3, advanced: 1, stillParked: 2, skipped: 0 },
};

function deps(over: Partial<DoctorDeps> & { shell?: ShellOpts } = {}): DoctorDeps {
  return {
    gateDir: "/data/repo.git",
    defaultBranch: "main",
    credentialPath: "/data/.ezcorp/extension-data/ez-code-factory/gate-key",
    run: over.run ?? makeRun(over.shell ?? {}),
    gh: over.gh ?? makeGh(0),
    resolveToken: over.resolveToken ?? (async () => "ghp_tok"),
    readHeartbeat: over.readHeartbeat ?? (async () => heartbeat),
  };
}

function check(report: { checks: Array<{ name: string; status: string; detail: string }> }, name: string) {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}

describe("runDoctor", () => {
  test("all-green: every check ok, report.ok true", async () => {
    const report = await runDoctor(deps());
    expect(report.ok).toBe(true);
    for (const c of report.checks) expect(c.status).toBe("ok");
    expect(report.checks.map((c) => c.name)).toEqual([
      "gate",
      "hook",
      "credential",
      "curl",
      "gh",
      "token",
      "default-branch",
      "trusted-upstream",
      "reconcile-sweep",
    ]);
  });

  test("gate not initialized → fail + report.ok false", async () => {
    const report = await runDoctor(deps({ shell: { bare: false } }));
    expect(check(report, "gate").status).toBe("fail");
    expect(check(report, "gate").detail).toContain("run init_gate");
    expect(report.ok).toBe(false);
  });

  test("missing hook → fail", async () => {
    const report = await runDoctor(deps({ shell: { hook: "missing" } }));
    expect(check(report, "hook").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("foreign (unmanaged) hook → warn (report still ok)", async () => {
    const report = await runDoctor(deps({ shell: { hook: "foreign" } }));
    expect(check(report, "hook").status).toBe("warn");
    expect(check(report, "hook").detail).toContain("NOT managed");
    expect(report.ok).toBe(true);
  });

  test("missing gate credential → fail with the mint command (report.ok false)", async () => {
    const report = await runDoctor(deps({ shell: { credential: "missing" } }));
    const c = check(report, "credential");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("ezcorp key mint --scopes read,chat");
    expect(c.detail).toContain("umask 077");
    expect(report.ok).toBe(false);
  });

  test("present gate credential → ok", async () => {
    const report = await runDoctor(deps());
    expect(check(report, "credential").status).toBe("ok");
  });

  test("curl not on PATH → fail (hook cannot POST, pushes silently dropped)", async () => {
    const report = await runDoctor(deps({ shell: { curl: "missing" } }));
    const c = check(report, "curl");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("curl not found");
    expect(report.ok).toBe(false);
  });

  test("curl present → ok (reports the resolved path)", async () => {
    const report = await runDoctor(deps());
    const c = check(report, "curl");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("/usr/bin/curl");
  });

  test("unfetchable trusted upstream → fail (every run fail-closes before any step)", async () => {
    const report = await runDoctor(deps({ shell: { lsRemote: "fail" } }));
    const c = check(report, "trusted-upstream");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("fail-closes");
    // The exact git failure is surfaced, not swallowed.
    expect(c.detail).toContain("could not read Username");
    expect(report.ok).toBe(false);
  });

  test("reachable trusted upstream → ok", async () => {
    const report = await runDoctor(deps());
    expect(check(report, "trusted-upstream").status).toBe("ok");
  });

  test("no origin → trusted-upstream defers to default-branch as a warn (not a fail)", async () => {
    const report = await runDoctor(deps({ shell: { origin: null } }));
    const c = check(report, "trusted-upstream");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("no origin");
    // Both no-origin checks warn; nothing FAILED, so the report stays ok.
    expect(report.ok).toBe(true);
  });

  test("gh not on PATH (127) → warn 'not found'", async () => {
    const report = await runDoctor(deps({ gh: makeGh(127) }));
    expect(check(report, "gh").status).toBe("warn");
    expect(check(report, "gh").detail).toContain("not found on PATH");
    expect(report.ok).toBe(true);
  });

  test("gh present but unauthenticated → warn 'not authenticated'", async () => {
    const report = await runDoctor(deps({ gh: makeGh(1) }));
    expect(check(report, "gh").status).toBe("warn");
    expect(check(report, "gh").detail).toContain("not authenticated");
  });

  test("no token → warn (gh falls back to ambient auth)", async () => {
    const report = await runDoctor(deps({ resolveToken: async () => null }));
    expect(check(report, "token").status).toBe("warn");
    expect(check(report, "token").detail).toContain("ambient auth");
  });

  test("token check NEVER echoes the resolved token value (no-leak guard)", async () => {
    const secret = "ghp_super_secret_value_do_not_leak_1234567890";
    const report = await runDoctor(deps({ resolveToken: async () => secret }));
    const token = check(report, "token");
    expect(token.status).toBe("ok");
    // The detail reports presence, never the plaintext token (log/report leak guard).
    expect(token.detail).not.toContain(secret);
  });

  test("no origin → warn (cannot fetch default branch / open PRs)", async () => {
    const report = await runDoctor(deps({ shell: { origin: null } }));
    expect(check(report, "default-branch").status).toBe("warn");
    expect(check(report, "default-branch").detail).toContain("no origin remote");
  });

  test("no sweep heartbeat → warn (loop has not fired)", async () => {
    const report = await runDoctor(deps({ readHeartbeat: async () => null }));
    expect(check(report, "reconcile-sweep").status).toBe("warn");
    expect(check(report, "reconcile-sweep").detail).toContain("has not fired");
  });

  test("sweep heartbeat present → ok with last-swept detail", async () => {
    const report = await runDoctor(deps());
    expect(check(report, "reconcile-sweep").status).toBe("ok");
    expect(check(report, "reconcile-sweep").detail).toContain("advanced 1");
  });
});
