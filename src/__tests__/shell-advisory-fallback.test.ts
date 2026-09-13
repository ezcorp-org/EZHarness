import { expect, mock, test } from "bun:test";

mock.module("../factory/boot", () => ({
  factoryBootConfig: { requireSandbox: false },
}));
mock.module("../extensions/sandbox/capability-probe", () => ({
  getSandboxTier: () => "advisory",
}));

const { resolveShellSandbox } = await import("../runtime/tools/shell");

test("shell preserves the feature-off advisory fallback", () => {
  expect(resolveShellSandbox("true", {
    workspaceDir: "/tmp/workspace",
    projectRoot: "/tmp/project",
  })).toBeNull();
});
