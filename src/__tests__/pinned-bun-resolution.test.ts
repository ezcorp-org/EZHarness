import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedBun, resolvePinnedBun } from "../../tests/postgres/helpers/pinned-bun";

// The PostgreSQL pool suites spawn this binary. A hosted runner has no /tmp/factory-tools; its setup-bun step
// installs the pin itself, and before this resolution the suites failed there with "posix_spawn ... ENOENT".
describe("the pinned Bun the PostgreSQL pool suites spawn", () => {
  const tools = "/opt/tools";
  const provisioned = "/opt/tools/bun-1.4.2/bun-linux-x64/bun";

  test("uses the provisioned tool directory when a proof host has it", () => {
    expect(resolvePinnedBun("1.4.2", tools, { version: "1.4.2", execPath: "/usr/bin/bun" }, path => path === provisioned)).toBe(provisioned);
  });

  test("uses the running Bun on a host without the tool directory, only when it is the pin", () => {
    expect(resolvePinnedBun("1.4.2", tools, { version: "1.4.2", execPath: "/home/runner/.bun/bin/bun" }, () => false)).toBe("/home/runner/.bun/bin/bun");
  });

  test("refuses another Bun by name instead of spawning it", () => {
    expect(() => resolvePinnedBun("1.4.2", tools, { version: "1.3.14", execPath: "/usr/bin/bun" }, () => false))
      .toThrow("pinned Bun 1.4.2 is missing at /opt/tools/bun-1.4.2/bun-linux-x64/bun and the running Bun is 1.3.14");
  });

  test("this process resolves a Bun of the repository's pin", () => {
    const pin = readFileSync(join(import.meta.dir, "../../.bun-version"), "utf8").trim();
    const reported = Bun.spawnSync([pinnedBun, "--version"]).stdout.toString().trim();
    expect(reported).toBe(pin);
  });
});
