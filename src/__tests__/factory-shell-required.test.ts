import { expect, mock, test } from "bun:test";

mock.module("../factory/boot", () => ({
  factoryBootConfig: { requireSandbox: true },
}));
mock.module("../extensions/sandbox/capability-probe", () => ({
  getSandboxTier: () => "advisory",
}));

const { resolveShellSandbox } = await import("../runtime/tools/shell");

test("required shell sandbox refuses an advisory host before spawning", () => {
  expect(() => resolveShellSandbox("touch /tmp/must-not-run", {
    workspaceDir: "/tmp/workspace",
    projectRoot: "/tmp/project",
  })).toThrow("Required shell sandbox isolation is unavailable");
});
