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
      "gh",
      "token",
      "default-branch",
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
