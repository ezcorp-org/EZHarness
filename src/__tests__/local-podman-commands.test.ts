import { describe, expect, test } from "bun:test";
import { CONFIG_LABEL, NATIVE_TOOLS_DESTINATION, RESOURCE_LABEL, configurationDigest, containerIdFromCreateOutput, createContainerArgv, resourceKey, resourcePaths, validateHostConfig } from "../runtime/sandbox/local-podman/commands";

const config = { stateRoot: "/tmp/ez-local", imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: `sha256:${"b".repeat(64)}`, podmanPath: "/bin/podman", fuse2fsPath: "/bin/fuse2fs", supervisorPath: "/bin/helper" };

describe("local Podman command boundary", () => {
  test("derives opaque contained paths", () => {
    expect(resourceKey("resource_1")).toHaveLength(64);
    expect(resourcePaths(config.stateRoot, "resource_1").root).toStartWith("/tmp/ez-local/");
    expect(() => resourcePaths(config.stateRoot, "../escape")).toThrow("invalid resource id");
  });
  test("accepts only pinned absolute host configuration", () => {
    expect(validateHostConfig(config).imageReference).toBe(config.imageReference);
    expect(() => validateHostConfig({ ...config, imageReference: "localhost/ezharness-local:latest" })).toThrow();
    expect(() => validateHostConfig({ ...config, imageId: "latest" })).toThrow();
    expect(() => validateHostConfig({ ...config, podmanPath: "podman" })).toThrow();
    expect(() => validateHostConfig({ ...config, stateRoot: "relative" })).toThrow();
    expect(() => validateHostConfig({ ...config, nativeToolsArtifact: "relative.js" })).toThrow("nativeToolsArtifact must be absolute");
  });
  test("builds fixed containment flags", () => {
    const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 };
    const argv = createContainerArgv(config, "r1", "ez-r1", "/tmp/ez-local/mount", limits);
    expect(argv).toContain("--network=none"); expect(argv).toContain("--read-only"); expect(argv).toContain("--cap-drop=ALL"); expect(argv).toContain("--log-driver=none");
    expect(argv).toContain(`${RESOURCE_LABEL}=${resourceKey("r1")}`);
    expect(argv).toContain(`${CONFIG_LABEL}=${configurationDigest(config, limits)}`);
    expect(argv.at(-2)).toBe("sleep");
    expect(() => createContainerArgv(config, "r1", "bad/name", "/tmp/x", { memoryBytes: 1, milliCpu: 1, pids: 0, diskBytes: 1 })).toThrow();
  });
  test("binds only the configured native tools artifact at the fixed read-only path", () => {
    const configured = validateHostConfig({ ...config, nativeToolsArtifact: "/tmp/artifacts/../native-tools.js" });
    const argv = createContainerArgv(configured, "r1", "ez-r1", "/tmp/ez-local/mount", { memoryBytes: 1, milliCpu: 1, pids: 1, diskBytes: 1 });
    expect(argv).toContain(`--mount=type=bind,source=/tmp/native-tools.js,destination=${NATIVE_TOOLS_DESTINATION},ro`);
  });
  test("accepts only one exact full container ID from create", () => {
    const id = "c".repeat(64);
    expect(containerIdFromCreateOutput(`${id}\n`)).toBe(id);
    expect(containerIdFromCreateOutput(`${id}\n${id}`)).toBeNull();
    expect(containerIdFromCreateOutput("container-name")).toBeNull();
  });
});
