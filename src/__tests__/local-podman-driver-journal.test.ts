import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalPodmanDriver } from "../runtime/sandbox/local-podman/driver";
import { DurableOperationJournal } from "../runtime/sandbox/local-podman/journal";
import { ResourceRoot } from "../runtime/sandbox/local-podman/resource-root";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, resourceKey, resourcePaths } from "../runtime/sandbox/local-podman/commands";
import { WorkspaceImage } from "../runtime/sandbox/local-podman/workspace-image";
import { validateProviderMethodExchange } from "@ezcorp/extension-contract";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(nativeToolsArtifact?: string) {
  const root = await mkdtemp(`${tmpdir()}/ez-driver-`); temporaryRoots.push(root); const log = `${root}/effects`; const podman = `${root}/podman`; const inspect = `${root}/inspect.json`; const fail = `${root}/fail`;
  await writeFile(podman, `#!/bin/sh\nif [ "$2" = info ]; then printf 'true v2\\n'; exit 0; fi\nif [ "$2" = inspect ]; then cat '${inspect}'; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\nif [ -f '${fail}' ]; then head -c 131072 /dev/zero | tr '\\000' x >&2; printf '%s' '${root}/private' >&2; exit 1; fi\nexit 0\n`); await chmod(podman, 0o700);
  const config = { stateRoot: `${root}/state`, imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: "b".repeat(64), podmanPath: podman, fuse2fsPath: podman, supervisorPath: podman, workspaceUid: 0, workspaceGid: 0, nativeToolsArtifact };
  const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 }; const containerId = "c".repeat(64); const containerName = "container";
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 }); const roots = new ResourceRoot(config.stateRoot); const paths = await roots.initialize("resource");
  await mkdir(paths.mount, { mode: 0o700 });
  const configDigest = configurationDigest(config, limits); await roots.writeMetadata("resource", { resourceId: "resource", containerId, containerName, configDigest, scope: input().call.scope, state: "stopped", limits });
  const live = { Id: containerId, Name: containerName, Image: config.imageId, State: { Running: false }, Config: { Image: config.imageReference, User: "0:0", Labels: { [RESOURCE_LABEL]: resourceKey("resource"), [CONFIG_LABEL]: configDigest } }, HostConfig: { NetworkMode: "none", UsernsMode: "", ReadonlyRootfs: true, Memory: limits.memoryBytes, MemorySwap: limits.memoryBytes, NanoCpus: limits.milliCpu * 1_000_000, PidsLimit: limits.pids }, Mounts: [{ Type: "bind", Source: paths.mount, Destination: "/workspace", RW: true }, ...(nativeToolsArtifact === undefined ? [] : [{ Type: "bind", Source: nativeToolsArtifact, Destination: "/opt/ezharness/native-tools.js", RW: false }])] };
  await writeFile(inspect, JSON.stringify([live]));
  return { driver: new LocalPodmanDriver(config), log, config, inspect, live, fail, root };
}
const input = () => ({ call: { scope: { projectId: "p", bindingId: "b", generation: 1 }, operationId: "op", idempotencyKey: "key", requestDigest: "a".repeat(64) }, resourceId: "resource" });
describe("local lifecycle journal integration", () => {
  test("creates and destroys a resource through owned command executables", async () => {
    const root = await mkdtemp(`${tmpdir()}/ez-driver-create-`); temporaryRoots.push(root); const stateRoot = `${root}/state`; await mkdir(stateRoot, { mode: 0o700 });
    const control = `${root}/control`; const fail = `${root}/fail`; const podman = `${root}/podman`; const containerId = "c".repeat(64);
    await writeFile(podman, `#!/etc/profiles/per-user/dev/bin/bash\nif [ "$2" = info ]; then echo 'true v2'; elif [ "$2" = create ]; then [ -f '${fail}' ] && exit 2; echo '${containerId}'; elif [ "$2" = inspect ]; then cat '${control}'; fi\n`); await chmod(podman, 0o700);
    const tool = `${root}/tool`; await writeFile(tool, "#!/etc/profiles/per-user/dev/bin/bash\nexit 0\n"); await chmod(tool, 0o700);
    const truncate = `${root}/truncate`; await writeFile(truncate, "#!/etc/profiles/per-user/dev/bin/bash\n/run/current-system/sw/bin/truncate \"$@\"\n"); await chmod(truncate, 0o700);
    const config = { stateRoot, imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: "b".repeat(64), podmanPath: podman, fuse2fsPath: tool, supervisorPath: "/bin/false", workspaceUid: 0, workspaceGid: 0 };
    const images = new WorkspaceImage(config, { truncate, mkfs: tool, unmount: tool, check: tool }); const driver = new LocalPodmanDriver(config, { workspaceImage: images });
    const createInput = { call: input().call, profile: "linux-exec.v1" as const, limits: { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 16 * 1024 * 1024 } };
    const created = await driver.create(createInput); expect(created.receipt.outcome).toBe("succeeded"); if (!("resource" in created)) throw new Error("missing resource");
    const paths = resourcePaths(stateRoot, created.resource.resourceId); const metadata = await new ResourceRoot(stateRoot).readMetadata<any>(created.resource.resourceId);
    const live = { Id: containerId, Name: metadata.containerName, Image: config.imageId, State: { Running: false }, Config: { Image: config.imageReference, User: "0:0", Labels: { [RESOURCE_LABEL]: resourceKey(created.resource.resourceId), [CONFIG_LABEL]: metadata.configDigest } }, HostConfig: { NetworkMode: "none", UsernsMode: "", ReadonlyRootfs: true, Memory: createInput.limits.memoryBytes, MemorySwap: createInput.limits.memoryBytes, NanoCpus: createInput.limits.milliCpu * 1_000_000, PidsLimit: createInput.limits.pids }, Mounts: [{ Type: "bind", Source: paths.mount, Destination: "/workspace", RW: true }] };
    await writeFile(control, JSON.stringify([live])); const destroyed = await driver.destroy({ call: { ...input().call, operationId: "destroy", idempotencyKey: "destroy" }, resourceId: created.resource.resourceId });
    expect(destroyed.receipt.outcome).toBe("succeeded");
    await writeFile(fail, "fail"); const failed = await driver.create({ ...createInput, call: { ...input().call, operationId: "create-failed", idempotencyKey: "create-failed" } });
    expect(failed.receipt).toMatchObject({ outcome: "failed", error: { code: "create_failed" } });
    expect((await readdir(stateRoot)).sort()).toEqual(["operations"]);
  });
  test("replays a completed mutation without another effect", async () => { const { driver, log } = await fixture(); const first = await driver.start(input()); const second = await driver.start(input()); expect(second).toEqual(first); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("recovers pending mutation as unknown without an effect", async () => { const { driver, log, config } = await fixture(); await new DurableOperationJournal(`${config.stateRoot}/operations`).begin(input().call); const result = await driver.start(input()); expect(result.receipt.outcome).toBe("unknown"); await expect(readFile(log, "utf8")).rejects.toThrow(); });
  test("rejects an idempotency collision before an effect", async () => { const { driver, log } = await fixture(); await driver.start(input()); await expect(driver.start({ ...input(), call: { ...input().call, requestDigest: "b".repeat(64) } })).rejects.toThrow("conflicts"); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("denies inspect, start, stop, and destroy before effects when exact identity differs", async () => {
    const changes: [string, (live: Record<string, any>) => void][] = [
      ["container ID", (live) => { live.Id = "d".repeat(64); }],
      ["container name", (live) => { live.Name = "other"; }],
      ["resource ownership label", (live) => { live.Config.Labels[RESOURCE_LABEL] = "wrong"; }],
      ["configuration label", (live) => { live.Config.Labels[CONFIG_LABEL] = "wrong"; }],
      ["pinned image ID", (live) => { live.Image = "d".repeat(64); }],
      ["pinned image reference", (live) => { live.Config.Image = `sha256:${"b".repeat(64)}`; }],
      ["workspace user", (live) => { live.Config.User = "1000:1000"; }],
      ["network", (live) => { live.HostConfig.NetworkMode = "bridge"; }],
      ["user namespace", (live) => { live.HostConfig.UsernsMode = "private"; }],
      ["read-only root", (live) => { live.HostConfig.ReadonlyRootfs = false; }],
      ["memory", (live) => { live.HostConfig.Memory += 1; }],
      ["memory swap", (live) => { live.HostConfig.MemorySwap += 1; }],
      ["CPU", (live) => { live.HostConfig.NanoCpus += 1; }],
      ["PID limit", (live) => { live.HostConfig.PidsLimit += 1; }],
      ["workspace source", (live) => { live.Mounts[0].Source = "/tmp/other"; }],
      ["workspace mode", (live) => { live.Mounts[0].RW = false; }],
      ["unexpected bind mount", (live) => { live.Mounts.push({ Type: "bind", Source: "/tmp/extra", Destination: "/extra", RW: true }); }],
    ];
    for (const [index, [name, change]] of changes.entries()) {
      const { driver, inspect, live, log } = await fixture(); change(live); await writeFile(inspect, JSON.stringify([live]));
      const calls = [() => driver.inspect(input()), () => driver.start({ ...input(), call: { ...input().call, operationId: `${index}-start`, idempotencyKey: `${index}-start` } }), () => driver.stop({ ...input(), call: { ...input().call, operationId: `${index}-stop`, idempotencyKey: `${index}-stop` } }), () => driver.destroy({ ...input(), call: { ...input().call, operationId: `${index}-destroy`, idempotencyKey: `${index}-destroy` } })];
      for (const invoke of calls) { const result = await invoke(); expect(result.receipt, name).toMatchObject({ outcome: "failed", error: { code: "identity_mismatch" } }); }
      await expect(readFile(log, "utf8")).rejects.toThrow();
    }
  });
  test("requires the configured native tools artifact at its fixed read-only mount", async () => {
    const tools = "/tmp/native-tools.js"; const { driver, inspect, live, log } = await fixture(tools); live.Mounts.pop(); await writeFile(inspect, JSON.stringify([live]));
    const result = await driver.start(input()); expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "identity_mismatch" } }); await expect(readFile(log, "utf8")).rejects.toThrow();
  });
  test("returns contract-exact receipts for success and failure without exposing Podman stderr", async () => {
    const { driver, fail, root, live, inspect } = await fixture(); const successfulInput = input(); const successful = await driver.start(successfulInput);
    expect(() => validateProviderMethodExchange("sandbox.lifecycle.v1", "start", successfulInput, successful)).not.toThrow(); expect(successful.receipt).not.toHaveProperty("scope");
    live.State.Running = true; await writeFile(inspect, JSON.stringify([live]));
    await writeFile(fail, "fail"); const failedInput = { ...input(), call: { ...input().call, operationId: "failed", idempotencyKey: "failed" } }; const failed = await driver.stop(failedInput);
    expect(() => validateProviderMethodExchange("sandbox.lifecycle.v1", "stop", failedInput, failed)).not.toThrow(); expect(JSON.stringify(failed)).not.toContain(root); expect(failed.receipt).toMatchObject({ outcome: "unknown", error: { code: "stopped_unknown", message: "Container stopped outcome is unknown." } });
  });
  test("resolves the persisted container generation before starting a process", async () => {
    const { driver, config, live, inspect } = await fixture(); const roots = new ResourceRoot(config.stateRoot);
    const metadata = await roots.readMetadata<any>("resource"); metadata.state = "running"; metadata.bootId = "boot-id"; await roots.writeMetadata("resource", metadata);
    live.State.Running = true; await writeFile(inspect, JSON.stringify([live]));
    const result = await driver.processStart({ call: { ...input().call, operationId: "process", idempotencyKey: "process" }, resourceId: "resource", argv: ["tool"], env: {}, cwd: "/", user: "workspace", timeoutMs: 1000 });
    expect(result.receipt.outcome, JSON.stringify(result)).toBe("succeeded");
  });
  test("rejects an unsafe request before filesystem or Podman effects", async () => {
    const { driver, log } = await fixture(); await expect(driver.start({ ...input(), resourceId: "../escape" })).rejects.toThrow(); await expect(readFile(log, "utf8")).rejects.toThrow();
  });
  test("rejects a different resource scope before the journal or Podman effects", async () => {
    const { driver, log, config } = await fixture(); const foreign = { ...input(), call: { ...input().call, scope: { ...input().call.scope, projectId: "foreign" } } }; const result = await driver.start(foreign);
    expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "scope_mismatch" } }); await expect(readFile(log, "utf8")).rejects.toThrow(); await expect(readdir(`${config.stateRoot}/operations`)).rejects.toThrow();
  });
  test("wires every file method with exact receipts, scope, revisions, and mutation replay", async () => {
    const { driver } = await fixture(); let sequence = 0; const fileCall = () => ({ ...input().call, operationId: `file-${++sequence}`, idempotencyKey: `file-${sequence}` });
    const mkdirInput = { call: fileCall(), resourceId: "resource", path: "/dir", recursive: false }; const made = await driver.fileMkdir(mkdirInput); expect(() => validateProviderMethodExchange("sandbox.files.v1", "mkdir", mkdirInput, made)).not.toThrow();
    const writeInput = { call: fileCall(), resourceId: "resource", path: "/dir/file", encoding: "utf8" as const, data: "value" }; const written = await driver.fileWrite(writeInput); expect(() => validateProviderMethodExchange("sandbox.files.v1", "write", writeInput, written)).not.toThrow(); expect(await driver.fileWrite(writeInput)).toEqual(written); if (!("entry" in written)) throw new Error("missing file");
    const statInput = { call: fileCall(), resourceId: "resource", path: "/dir/file" }; const stated = await driver.fileStat(statInput); expect(() => validateProviderMethodExchange("sandbox.files.v1", "stat", statInput, stated)).not.toThrow();
    const listInput = { call: fileCall(), resourceId: "resource", path: "/dir", limit: 1 }; const listed = await driver.fileList(listInput); expect(() => validateProviderMethodExchange("sandbox.files.v1", "list", listInput, listed)).not.toThrow();
    const readInput = { call: fileCall(), resourceId: "resource", path: "/dir/file", offsetBytes: 0, lengthBytes: 16 }; expect(await driver.fileRead(readInput)).toMatchObject({ receipt: { outcome: "succeeded" }, data: "value" });
    const chmodInput = { call: fileCall(), resourceId: "resource", path: "/dir/file", expectedRevision: written.entry.revision, mode: 0o640 }; expect((await driver.fileChmod(chmodInput)).receipt.outcome).toBe("succeeded");
    const removeInput = { call: fileCall(), resourceId: "resource", path: "/dir", recursive: true }; expect((await driver.fileRemove(removeInput)).receipt.outcome).toBe("succeeded");
    const foreign = { ...statInput, call: { ...fileCall(), scope: { ...input().call.scope, projectId: "foreign" } } }; expect(await driver.fileStat(foreign)).toMatchObject({ receipt: { outcome: "failed", error: { code: "scope_mismatch" } } });
  });
});
