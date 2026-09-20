import { describe, expect, test } from "bun:test";
import { createContainerArgv, resourceKey, resourcePaths, validateHostConfig } from "../runtime/sandbox/local-podman/commands";

const config = { stateRoot: "/tmp/ez-local", imageDigest: `sha256:${"a".repeat(64)}`, podmanPath: "/bin/podman", fuse2fsPath: "/bin/fuse2fs", supervisorPath: "/bin/helper" };

describe("local Podman command boundary", () => {
  test("derives opaque contained paths", () => {
    expect(resourceKey("resource_1")).toHaveLength(64);
    expect(resourcePaths(config.stateRoot, "resource_1").root).toStartWith("/tmp/ez-local/");
    expect(() => resourcePaths(config.stateRoot, "../escape")).toThrow("invalid resource id");
  });
  test("accepts only pinned absolute host configuration", () => {
    expect(validateHostConfig(config).imageDigest).toBe(config.imageDigest);
    expect(() => validateHostConfig({ ...config, imageDigest: "latest" })).toThrow();
    expect(() => validateHostConfig({ ...config, podmanPath: "podman" })).toThrow();
    expect(() => validateHostConfig({ ...config, stateRoot: "relative" })).toThrow();
  });
  test("builds fixed containment flags", () => {
    const argv = createContainerArgv(config, "r1", "ez-r1", "/tmp/ez-local/mount", { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 });
    expect(argv).toContain("--network=none"); expect(argv).toContain("--read-only"); expect(argv).toContain("--cap-drop=ALL"); expect(argv).toContain("--log-driver=none");
    expect(argv.at(-2)).toBe("sleep");
    expect(() => createContainerArgv(config, "r1", "bad/name", "/tmp/x", { memoryBytes: 1, milliCpu: 1, pids: 0, diskBytes: 1 })).toThrow();
  });
});
