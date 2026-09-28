import { expect, mock, test } from "bun:test";

mock.module("../factory/boot", () => ({
  factoryBootConfig: { requireSandbox: true },
}));
let tier = "advisory";
mock.module("../extensions/sandbox/capability-probe", () => ({
  getSandboxTier: () => tier,
}));

const { resolveShellSandbox } = await import("../runtime/tools/shell");

test("required shell sandbox refuses an advisory host before spawning", () => {
  expect(() => resolveShellSandbox("touch /tmp/must-not-run", {
    workspaceDir: "/tmp/workspace",
    projectRoot: "/tmp/project",
  })).toThrow("Required shell sandbox isolation is unavailable");
});

test("required shell sandbox refuses a missing sandbox wiring", () => {
  expect(() => resolveShellSandbox("touch /tmp/must-not-run", undefined)).toThrow("Required shell sandbox wiring is unavailable.");
});

test("required shell sandbox refuses a jail it cannot build, and names why", () => {
  tier = "bwrap";
  try {
    // A workspace under /dev/null can never be created, so the jail build fails.
    expect(() => resolveShellSandbox("touch /tmp/must-not-run", {
      workspaceDir: "/dev/null/workspace",
      projectRoot: "/tmp/project",
    })).toThrow(/^Required shell sandbox isolation is unavailable: .*\/dev\/null/);
  } finally {
    tier = "advisory";
  }
});
