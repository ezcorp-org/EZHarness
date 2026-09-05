import { expect, test } from "bun:test";
import { AUTO_ENABLE_ON_INSTALL, installFromLocal, installFromGit, installFromGitHub, shouldAutoEnableOnInstall } from "../installer";

test("legacy installers cannot bypass lifecycle builds or grant approval", async () => {
  expect(AUTO_ENABLE_ON_INSTALL.size).toBe(0);
  expect(shouldAutoEnableOnInstall("task-stack")).toBe(false);
  const grants = { grantedAt: {} };
  await expect(installFromLocal("/tmp/untrusted", grants, true)).rejects.toThrow("EXTENSION_V4_REQUIRED");
  await expect(installFromGit("https://attacker.invalid/repository", grants)).rejects.toThrow("EXTENSION_V4_REQUIRED");
  await expect(installFromGitHub("attacker/repository", grants)).rejects.toThrow("EXTENSION_V4_REQUIRED");
});
