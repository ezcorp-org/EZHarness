import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalPodmanDriver } from "../runtime/sandbox/local-podman/driver";
import { DurableOperationJournal } from "../runtime/sandbox/local-podman/journal";
import { ResourceRoot } from "../runtime/sandbox/local-podman/resource-root";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, resourceKey } from "../runtime/sandbox/local-podman/commands";
import { validateProviderMethodExchange } from "@ezcorp/extension-contract";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(nativeToolsArtifact?: string) {
  const root = await mkdtemp(`${tmpdir()}/ez-driver-`); temporaryRoots.push(root); const log = `${root}/effects`; const podman = `${root}/podman`; const inspect = `${root}/inspect.json`; const fail = `${root}/fail`;
  await writeFile(podman, `#!/bin/sh\nif [ "$2" = inspect ]; then cat '${inspect}'; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\nif [ -f '${fail}' ]; then head -c 131072 /dev/zero | tr '\\000' x >&2; printf '%s' '${root}/private' >&2; exit 1; fi\nexit 0\n`); await chmod(podman, 0o700);
  const config = { stateRoot: `${root}/state`, imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: `sha256:${"b".repeat(64)}`, podmanPath: podman, fuse2fsPath: "/bin/false", supervisorPath: "/bin/false", workspaceUid: 1000, workspaceGid: 1000, nativeToolsArtifact };
  const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 }; const containerId = "c".repeat(64); const containerName = "container";
  await mkdir(config.stateRoot, { recursive: true }); const roots = new ResourceRoot(config.stateRoot); const paths = await roots.initialize("resource");
  const configDigest = configurationDigest(config, limits); await roots.writeMetadata("resource", { resourceId: "resource", containerId, containerName, configDigest, state: "stopped", limits });
  const live = { Id: containerId, Name: containerName, Image: config.imageId, Config: { Image: config.imageReference, User: "1000:1000", Labels: { [RESOURCE_LABEL]: resourceKey("resource"), [CONFIG_LABEL]: configDigest } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Memory: limits.memoryBytes, MemorySwap: limits.memoryBytes, NanoCpus: limits.milliCpu * 1_000_000, PidsLimit: limits.pids }, Mounts: [{ Type: "bind", Source: paths.mount, Destination: "/workspace", RW: true }, ...(nativeToolsArtifact === undefined ? [] : [{ Type: "bind", Source: nativeToolsArtifact, Destination: "/opt/ezharness/native-tools.js", RW: false }])] };
  await writeFile(inspect, JSON.stringify([live]));
  return { driver: new LocalPodmanDriver(config), log, config, inspect, live, fail, root };
}
const input = () => ({ call: { scope: { projectId: "p", bindingId: "b", generation: 1 }, operationId: "op", idempotencyKey: "key", requestDigest: "a".repeat(64) }, resourceId: "resource" });
describe("local lifecycle journal integration", () => {
  test("replays a completed mutation without another effect", async () => { const { driver, log } = await fixture(); const first = await driver.start(input()); const second = await driver.start(input()); expect(second).toEqual(first); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("recovers pending mutation as unknown without an effect", async () => { const { driver, log, config } = await fixture(); await new DurableOperationJournal(`${config.stateRoot}/operations`).begin(input().call); const result = await driver.start(input()); expect(result.receipt.outcome).toBe("unknown"); await expect(readFile(log, "utf8")).rejects.toThrow(); });
  test("rejects an idempotency collision before an effect", async () => { const { driver, log } = await fixture(); await driver.start(input()); await expect(driver.start({ ...input(), call: { ...input().call, requestDigest: "b".repeat(64) } })).rejects.toThrow("conflicts"); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("denies inspect, start, stop, and destroy before effects when exact identity differs", async () => {
    const changes: [string, (live: Record<string, any>) => void][] = [
      ["container ID", (live) => { live.Id = "d".repeat(64); }],
      ["container name", (live) => { live.Name = "other"; }],
      ["resource ownership label", (live) => { live.Config.Labels[RESOURCE_LABEL] = "wrong"; }],
      ["configuration label", (live) => { live.Config.Labels[CONFIG_LABEL] = "wrong"; }],
      ["pinned image ID", (live) => { live.Image = `sha256:${"d".repeat(64)}`; }],
      ["pinned image reference", (live) => { live.Config.Image = `sha256:${"b".repeat(64)}`; }],
      ["workspace user", (live) => { live.Config.User = "0:0"; }],
      ["network", (live) => { live.HostConfig.NetworkMode = "bridge"; }],
      ["read-only root", (live) => { live.HostConfig.ReadonlyRootfs = false; }],
      ["memory", (live) => { live.HostConfig.Memory += 1; }],
      ["memory swap", (live) => { live.HostConfig.MemorySwap += 1; }],
      ["CPU", (live) => { live.HostConfig.NanoCpus += 1; }],
      ["PID limit", (live) => { live.HostConfig.PidsLimit += 1; }],
      ["workspace source", (live) => { live.Mounts[0].Source = "/tmp/other"; }],
      ["workspace mode", (live) => { live.Mounts[0].RW = false; }],
      ["unexpected bind mount", (live) => { live.Mounts.push({ Type: "bind", Source: "/tmp/extra", Destination: "/extra", RW: true }); }],
    ];
    for (const [index, [, change]] of changes.entries()) {
      const { driver, inspect, live, log } = await fixture(); change(live); await writeFile(inspect, JSON.stringify([live]));
      const calls = [driver.inspect(input()), driver.start({ ...input(), call: { ...input().call, operationId: `${index}-start`, idempotencyKey: `${index}-start` } }), driver.stop({ ...input(), call: { ...input().call, operationId: `${index}-stop`, idempotencyKey: `${index}-stop` } }), driver.destroy({ ...input(), call: { ...input().call, operationId: `${index}-destroy`, idempotencyKey: `${index}-destroy` } })];
      const results = await Promise.all(calls); for (const result of results) { expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "identity_mismatch" } }); }
      await expect(readFile(log, "utf8")).rejects.toThrow();
    }
  });
  test("requires the configured native tools artifact at its fixed read-only mount", async () => {
    const tools = "/tmp/native-tools.js"; const { driver, inspect, live, log } = await fixture(tools); live.Mounts.pop(); await writeFile(inspect, JSON.stringify([live]));
    const result = await driver.start(input()); expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "identity_mismatch" } }); await expect(readFile(log, "utf8")).rejects.toThrow();
  });
  test("returns contract-exact receipts for success and failure without exposing Podman stderr", async () => {
    const { driver, fail, root } = await fixture(); const successfulInput = input(); const successful = await driver.start(successfulInput);
    expect(() => validateProviderMethodExchange("sandbox.lifecycle.v1", "start", successfulInput, successful)).not.toThrow(); expect(successful.receipt).not.toHaveProperty("scope");
    await writeFile(fail, "fail"); const failedInput = { ...input(), call: { ...input().call, operationId: "failed", idempotencyKey: "failed" } }; const failed = await driver.stop(failedInput);
    expect(() => validateProviderMethodExchange("sandbox.lifecycle.v1", "stop", failedInput, failed)).not.toThrow(); expect(JSON.stringify(failed)).not.toContain(root); expect(failed.receipt).toMatchObject({ outcome: "unknown", error: { code: "stopped_unknown", message: "Container stopped outcome is unknown." } });
  });
  test("rejects an unsafe request before filesystem or Podman effects", async () => {
    const { driver, log } = await fixture(); await expect(driver.start({ ...input(), resourceId: "../escape" })).rejects.toThrow(); await expect(readFile(log, "utf8")).rejects.toThrow();
  });
});
