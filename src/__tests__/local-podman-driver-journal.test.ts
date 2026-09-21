import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalPodmanDriver } from "../runtime/sandbox/local-podman/driver";
import { DurableOperationJournal } from "../runtime/sandbox/local-podman/journal";
import { ResourceRoot } from "../runtime/sandbox/local-podman/resource-root";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, resourceKey, resourcePaths } from "../runtime/sandbox/local-podman/commands";
import { WorkspaceImage } from "../runtime/sandbox/local-podman/workspace-image";
import { validateProviderMethodExchange } from "@ezcorp/extension-contract";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(nativeToolsArtifact?: string, processStatus = "NoNewPrivs:\t1\nSeccomp:\t2\n") {
  const root = await mkdtemp(`${tmpdir()}/ez-driver-`); temporaryRoots.push(root); const log = `${root}/effects`; const podman = `${root}/podman`; const inspect = `${root}/inspect.json`; const fail = `${root}/fail`; const stopFail = `${root}/stop-fail`; const running = `${root}/running`;
  await writeFile(podman, `#!/bin/sh\nif [ "$2" = info ]; then printf 'true v2 true\\n'; exit 0; fi\nif [ "$2" = inspect ]; then if [ -f '${running}' ]; then sed 's/"State":{"Running":false,"Pid":0}/"State":{"Running":true,"Pid":4242}/' '${inspect}'; else cat '${inspect}'; fi; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\nif [ -f '${fail}' ] || { [ "$2" = stop ] && [ -f '${stopFail}' ]; }; then head -c 131072 /dev/zero | tr '\\000' x >&2; printf '%s' '${root}/private' >&2; exit 1; fi\nif [ "$2" = start ]; then touch '${running}'; fi\nif [ "$2" = stop ]; then rm -f '${running}'; fi\nexit 0\n`); await chmod(podman, 0o700);
  const config = { stateRoot: `${root}/state`, imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: "b".repeat(64), podmanPath: podman, fuse2fsPath: podman, supervisorPath: podman, workspaceUid: 0, workspaceGid: 0, nativeToolsArtifact };
  const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 32 * 1024 * 1024 }; const containerId = "c".repeat(64); const containerName = "container";
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 }); const roots = new ResourceRoot(config.stateRoot); const paths = await roots.initialize("resource");
  await mkdir(paths.mount, { mode: 0o700 });
  const configDigest = configurationDigest(config, limits); await roots.writeMetadata("resource", { resourceId: "resource", containerId, containerName, configDigest, scope: input().call.scope, state: "stopped", limits });
  const capDrop = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_NET_BIND_SERVICE", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID", "CAP_SYS_CHROOT"]; const live = { Id: containerId, Name: containerName, Image: config.imageId, State: { Running: false, Pid: 0 }, Config: { Image: config.imageReference, User: "0:0", Labels: { [RESOURCE_LABEL]: resourceKey("resource"), [CONFIG_LABEL]: configDigest } }, HostConfig: { NetworkMode: "none", UsernsMode: "", PidMode: "private", IpcMode: "private", UtsMode: null, Privileged: false, CapDrop: capDrop, SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true, Memory: limits.memoryBytes, MemorySwap: limits.memoryBytes, NanoCpus: limits.milliCpu * 1_000_000, PidsLimit: limits.pids }, Mounts: [{ Type: "bind", Source: paths.mount, Destination: "/workspace", RW: true }, ...(nativeToolsArtifact === undefined ? [] : [{ Type: "bind", Source: nativeToolsArtifact, Destination: "/opt/ezharness/native-tools.js", RW: false }])] };
  await writeFile(inspect, JSON.stringify([live]));
  return { driver: new LocalPodmanDriver(config, { readProcessStatus: async () => processStatus }), log, config, inspect, live, fail, stopFail, root };
}
const input = () => ({ call: { scope: { projectId: "p", bindingId: "b", generation: 1 }, operationId: "op", idempotencyKey: "key", requestDigest: "a".repeat(64) }, resourceId: "resource" });
describe("local lifecycle journal integration", () => {
  test("creates and destroys a resource through owned command executables", async () => {
    const root = await mkdtemp(`${tmpdir()}/ez-driver-create-`); temporaryRoots.push(root); const stateRoot = `${root}/state`; await mkdir(stateRoot, { mode: 0o700 });
    const control = `${root}/control`; const fail = `${root}/fail`; const podman = `${root}/podman`; const containerId = "c".repeat(64);
    await writeFile(podman, `#!${process.execPath}\nimport { readFile } from "node:fs/promises"; const args = process.argv.slice(2); let mode = ""; try { mode = await readFile(${JSON.stringify(fail)}, "utf8"); } catch {} if (args[1] === "info") console.log("true v2 true"); else if (args[1] === "create") { if (mode === "fail") process.exit(2); console.log(mode === "malformed" ? "not-an-id" : ${JSON.stringify(containerId)}); } else if (args[1] === "inspect") process.stdout.write(await readFile(${JSON.stringify(control)}, "utf8")); else if (args[1] === "container" && args[2] === "exists") process.exit(1);\n`); await chmod(podman, 0o700);
    const tool = `${root}/tool`; await writeFile(tool, `#!${process.execPath}\n`); await chmod(tool, 0o700);
    const truncate = `${root}/truncate`; await writeFile(truncate, `#!${process.execPath}\nimport { writeFile } from "node:fs/promises"; const args = process.argv.slice(2); await writeFile(args.at(-1), new Uint8Array(1));\n`); await chmod(truncate, 0o700);
    const config = { stateRoot, imageReference: `localhost/ezharness-local@sha256:${"a".repeat(64)}`, imageId: "b".repeat(64), podmanPath: podman, fuse2fsPath: tool, supervisorPath: "/bin/false", workspaceUid: 0, workspaceGid: 0 };
    const images = new WorkspaceImage(config, { truncate, mkfs: tool, unmount: tool, check: tool }); const driver = new LocalPodmanDriver(config, { workspaceImage: images });
    const createInput = { call: input().call, profile: "linux-exec.v1" as const, limits: { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 32, diskBytes: 16 * 1024 * 1024 } };
    const created = await driver.create(createInput); expect(created.receipt.outcome).toBe("succeeded"); if (!("resource" in created)) throw new Error("missing resource");
    const paths = resourcePaths(stateRoot, created.resource.resourceId); const metadata = await new ResourceRoot(stateRoot).readMetadata<any>(created.resource.resourceId);
    const capDrop = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_NET_BIND_SERVICE", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID", "CAP_SYS_CHROOT"]; const live = { Id: containerId, Name: metadata.containerName, Image: config.imageId, State: { Running: false }, Config: { Image: config.imageReference, User: "0:0", Labels: { [RESOURCE_LABEL]: resourceKey(created.resource.resourceId), [CONFIG_LABEL]: metadata.configDigest } }, HostConfig: { NetworkMode: "none", UsernsMode: "", PidMode: "private", IpcMode: "private", UtsMode: null, Privileged: false, CapDrop: capDrop, SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true, Memory: createInput.limits.memoryBytes, MemorySwap: createInput.limits.memoryBytes, NanoCpus: createInput.limits.milliCpu * 1_000_000, PidsLimit: createInput.limits.pids }, Mounts: [{ Type: "bind", Source: paths.mount, Destination: "/workspace", RW: true }] };
    await writeFile(control, JSON.stringify([live])); const createJournal = (await readdir(`${stateRoot}/operations`))[0]!; await writeFile(`${stateRoot}/operations/${createJournal}`, JSON.stringify({ version: 1, state: "pending", call: createInput.call }));
    expect(await new LocalPodmanDriver(config, { workspaceImage: images }).create(createInput)).toEqual(created);
    const destroyed = await driver.destroy({ call: { ...input().call, operationId: "destroy", idempotencyKey: "destroy" }, resourceId: created.resource.resourceId });
    expect(destroyed.receipt.outcome).toBe("succeeded");
    await writeFile(fail, "fail"); const failed = await driver.create({ ...createInput, call: { ...input().call, operationId: "create-failed", idempotencyKey: "create-failed" } });
    expect(failed.receipt).toMatchObject({ outcome: "failed", error: { code: "create_failed_clean" } });
    expect((await readdir(stateRoot)).sort()).toEqual(["operations"]);
    const recoverCall = { ...input().call, operationId: "recover", idempotencyKey: "recover" }; await writeFile(fail, "malformed");
    const uncertain = await driver.create({ ...createInput, call: recoverCall }); expect(uncertain.receipt.outcome).toBe("unknown");
    const hash = createHash("sha256").update(JSON.stringify({ scope: recoverCall.scope, operationId: recoverCall.operationId, idempotencyKey: recoverCall.idempotencyKey, requestDigest: recoverCall.requestDigest })).digest("hex"); const recoveredId = `r-${hash.slice(0, 48)}`; const recoveredPaths = resourcePaths(stateRoot, recoveredId); const recoveredDigest = configurationDigest(config, createInput.limits);
    await writeFile(control, JSON.stringify([{ ...live, Name: `ez-local-${recoveredId}`, Config: { ...live.Config, Labels: { [RESOURCE_LABEL]: resourceKey(recoveredId), [CONFIG_LABEL]: recoveredDigest } }, Mounts: [{ Type: "bind", Source: recoveredPaths.mount, Destination: "/workspace", RW: true }] }]));
    const recovered = await new LocalPodmanDriver(config, { workspaceImage: images }).create({ ...createInput, call: recoverCall }); expect(recovered).toMatchObject({ receipt: { outcome: "succeeded" }, resource: { resourceId: recoveredId } });
    const preJournalCall = { ...input().call, operationId: "pre-reservation", idempotencyKey: "pre-reservation" }; await new DurableOperationJournal(`${stateRoot}/operations`).beginRecoverable(preJournalCall); await writeFile(fail, "");
    expect((await new LocalPodmanDriver(config, { workspaceImage: images }).create({ ...createInput, call: preJournalCall })).receipt.outcome).toBe("succeeded");
  });
  test("replays a completed mutation without another effect", async () => { const { driver, log } = await fixture(); const first = await driver.start(input()); const second = await driver.start(input()); expect(second).toEqual(first); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("fails closed and stops a container whose process confinement cannot be verified", async () => {
    const { driver, log } = await fixture(undefined, "NoNewPrivs:\t1\nSeccomp:\t0\n");
    const result = await driver.start(input());
    expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "confinement_unverified" } });
    expect((await readFile(log, "utf8")).trim().split("\n").map((line) => line.split(" ")[1])).toEqual(["start", "stop"]);
  });
  test("stops an unconfined running container observed after restart", async () => {
    const { driver, inspect, live, log } = await fixture(undefined, "NoNewPrivs:\t1\nSeccomp:\t0\n");
    live.State = { Running: true, Pid: 4242 }; await writeFile(inspect, JSON.stringify([live]));
    const result = await driver.inspect(input());
    expect(result.receipt).toMatchObject({ outcome: "failed", error: { code: "confinement_unverified" } });
    expect((await readFile(log, "utf8")).trim().split(" ")[1]).toBe("stop");
  });
  test("reports an unknown outcome when an unconfined container cannot be stopped", async () => {
    const { driver, stopFail } = await fixture(undefined, "NoNewPrivs:\t1\nSeccomp:\t0\n"); await writeFile(stopFail, "fail");
    const result = await driver.start(input());
    expect(result.receipt).toMatchObject({ outcome: "unknown", error: { code: "running_unknown", retryable: true } });
  });
  test("accepts Podman's omitted UTS mode as its normalized private namespace", async () => { const { driver, live, inspect } = await fixture(); delete (live.HostConfig as Record<string, unknown>).UtsMode; await writeFile(inspect, JSON.stringify([live])); expect((await driver.start(input())).receipt.outcome).toBe("succeeded"); });
  test("recovers pending mutation as unknown without an effect", async () => { const { driver, log, config } = await fixture(); await new DurableOperationJournal(`${config.stateRoot}/operations`).begin(input().call); const result = await driver.start(input()); expect(result.receipt.outcome).toBe("unknown"); await expect(readFile(log, "utf8")).rejects.toThrow(); });
  test("recovers file mutations after their filesystem effects but before journal completion", async () => {
    const { config } = await fixture();
    const paths = resourcePaths(config.stateRoot, "resource");
    const journal = new DurableOperationJournal(`${config.stateRoot}/operations`);
    const recoveryCall = (name: string) => ({ ...input().call, operationId: `${name}-recovery`, idempotencyKey: `${name}-recovery` });

    const call = { ...input().call, operationId: "write-recovery", idempotencyKey: "write-recovery" };
    const request = { call, resourceId: "resource", path: "/recovered.txt", encoding: "utf8" as const, data: "recovered" };
    await journal.beginRecoverableMutation(call, async () => ({ priorRevision: null }));
    await writeFile(`${paths.mount}/recovered.txt`, "recovered");
    const recovered = await new LocalPodmanDriver(config).fileWrite(request);
    expect(recovered).toMatchObject({ receipt: { outcome: "succeeded" }, entry: { path: "/recovered.txt", sizeBytes: 9 } });
    expect(await new LocalPodmanDriver(config).fileWrite(request)).toEqual(recovered);

    const mkdirCall = recoveryCall("mkdir");
    await journal.beginRecoverableMutation(mkdirCall, async () => ({}));
    await mkdir(`${paths.mount}/recovered-dir`);
    expect(await new LocalPodmanDriver(config).fileMkdir({ call: mkdirCall, resourceId: "resource", path: "/recovered-dir", recursive: false })).toMatchObject({ receipt: { outcome: "succeeded" }, entry: { kind: "directory" } });

    await writeFile(`${paths.mount}/mode.txt`, "mode");
    const chmodCall = recoveryCall("chmod");
    await journal.beginRecoverableMutation(chmodCall, async () => ({}));
    await chmod(`${paths.mount}/mode.txt`, 0o640);
    expect(await new LocalPodmanDriver(config).fileChmod({ call: chmodCall, resourceId: "resource", path: "/mode.txt", mode: 0o640 })).toMatchObject({ receipt: { outcome: "succeeded" }, entry: { mode: 0o640 } });

    await writeFile(`${paths.mount}/removed.txt`, "removed");
    const removeCall = recoveryCall("remove");
    const beforeRemove = await new LocalPodmanDriver(config).fileStat({ call: recoveryCall("remove-stat"), resourceId: "resource", path: "/removed.txt" });
    if (!("entry" in beforeRemove)) throw new Error("missing removal revision");
    await journal.beginRecoverableMutation(removeCall, async () => ({ priorRevision: beforeRemove.entry.revision }));
    await rm(`${paths.mount}/removed.txt`);
    expect(await new LocalPodmanDriver(config).fileRemove({ call: removeCall, resourceId: "resource", path: "/removed.txt", recursive: false })).toMatchObject({ receipt: { outcome: "succeeded" }, removedRevision: beforeRemove.entry.revision });
  });

  test("terminalizes an interrupted file mutation whose effect is absent", async () => {
    const { config } = await fixture();
    const call = { ...input().call, operationId: "write-abort", idempotencyKey: "write-abort" };
    const request = { call, resourceId: "resource", path: "/missing.txt", encoding: "utf8" as const, data: "not-written" };
    await new DurableOperationJournal(`${config.stateRoot}/operations`).beginRecoverableMutation(call, async () => ({ priorRevision: null }));
    const failed = await new LocalPodmanDriver(config).fileWrite(request);
    expect(failed.receipt).toMatchObject({ outcome: "failed", error: { code: "interrupted_mutation", retryable: false } });
    expect(await new LocalPodmanDriver(config).fileWrite(request)).toEqual(failed);
    const paths = resourcePaths(config.stateRoot, "resource");
    await writeFile(`${paths.mount}/same.txt`, "same");
    const mismatchCall = { ...input().call, operationId: "write-cas-abort", idempotencyKey: "write-cas-abort" };
    const observed = await new LocalPodmanDriver(config).fileStat({ call: { ...mismatchCall, operationId: "write-cas-stat", idempotencyKey: "write-cas-stat" }, resourceId: "resource", path: "/same.txt" });
    if (!("entry" in observed)) throw new Error("missing file revision");
    await new DurableOperationJournal(`${config.stateRoot}/operations`).beginRecoverableMutation(mismatchCall, async () => ({ priorRevision: observed.entry.revision }));
    const mismatch = await new LocalPodmanDriver(config).fileWrite({ call: mismatchCall, resourceId: "resource", path: "/same.txt", expectedRevision: "different", encoding: "utf8", data: "same" });
    expect(mismatch.receipt).toMatchObject({ outcome: "failed", error: { code: "interrupted_mutation" } });
    const fresh = await new LocalPodmanDriver(config).fileWrite({ ...request, call: { ...call, operationId: "write-after-abort", idempotencyKey: "write-after-abort" } });
    expect(fresh.receipt.outcome).toBe("succeeded");
  });
  test("recovers disposal after workspace cleanup was interrupted", async () => {
    const f = await fixture(); const paths = resourcePaths(f.config.stateRoot, "resource"); await writeFile(paths.image, "image");
    class InterruptedCleanup extends WorkspaceImage { override async destroy(image: string, mount: string) { await rm(image, { force: true }); await rm(mount, { recursive: true, force: true }); throw new Error("crash after unmount"); } }
    const call = { ...input().call, operationId: "destroy-recovery", idempotencyKey: "destroy-recovery" };
    const first = await new LocalPodmanDriver(f.config, { workspaceImage: new InterruptedCleanup(f.config) }).destroy({ call, resourceId: "resource" });
    expect(first.receipt).toMatchObject({ outcome: "unknown", error: { code: "cleanup_unknown" } });
    const recovered = await new LocalPodmanDriver(f.config).destroy({ call, resourceId: "resource" });
    expect(recovered).toMatchObject({ receipt: { outcome: "succeeded" }, resource: { observedState: "destroyed" } });
    await expect(stat(paths.root)).rejects.toThrow();
    const freshCall = { ...input().call, operationId: "destroy-fresh", idempotencyKey: "destroy-fresh", requestDigest: "d".repeat(64) };
    const retried = await new LocalPodmanDriver(f.config).destroy({ call: freshCall, resourceId: "resource" });
    expect(retried).toMatchObject({ receipt: { operationId: freshCall.operationId, requestDigest: freshCall.requestDigest, outcome: "succeeded" }, resource: { resourceId: "resource", observedState: "destroyed" } });
    const foreign = await new LocalPodmanDriver(f.config).destroy({ call: { ...freshCall, operationId: "foreign", idempotencyKey: "foreign", scope: { ...freshCall.scope, projectId: "foreign" } }, resourceId: "resource" });
    expect(foreign.receipt).toMatchObject({ outcome: "failed", error: { code: "scope_mismatch" } });
  });
  test("finishes root cleanup before replaying a durably completed disposal", async () => {
    const f = await fixture(); const call = { ...input().call, operationId: "destroy-complete", idempotencyKey: "destroy-complete" };
    const limits = f.live.HostConfig; const result = { receipt: { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "succeeded" as const }, resource: { resourceId: "resource", desiredState: "destroyed" as const, observedState: "destroyed" as const, limits: { memoryBytes: limits.Memory, milliCpu: limits.NanoCpus / 1_000_000, pids: limits.PidsLimit, diskBytes: 32 * 1024 * 1024 } } };
    const journal = new DurableOperationJournal(`${f.config.stateRoot}/operations`); await journal.beginRecoverable(call); await journal.complete(call, result);
    await expect(new LocalPodmanDriver(f.config).destroy({ call, resourceId: "other" })).rejects.toThrow("identity mismatch");
    expect((await stat(resourcePaths(f.config.stateRoot, "resource").root)).isDirectory()).toBe(true);
    expect(await new LocalPodmanDriver(f.config).destroy({ call, resourceId: "resource" })).toEqual(result);
    await expect(stat(resourcePaths(f.config.stateRoot, "resource").root)).rejects.toThrow();
  });
  test("serializes concurrent retries of the same disposal", async () => {
    const f = await fixture(); let cleanups = 0; let active = 0; let maximumActive = 0; const firstEntered = Promise.withResolvers<void>(); const releaseFirst = Promise.withResolvers<void>(); const secondEntered = Promise.withResolvers<void>(); const releaseSecond = Promise.withResolvers<void>();
    class PausedCleanup extends WorkspaceImage { override async destroy() { cleanups++; active++; maximumActive = Math.max(maximumActive, active); try { if (cleanups === 1) { firstEntered.resolve(); await releaseFirst.promise; throw new Error("interrupted"); } secondEntered.resolve(); await releaseSecond.promise; } finally { active--; } } }
    const driver = new LocalPodmanDriver(f.config, { workspaceImage: new PausedCleanup(f.config) }); const call = { ...input().call, operationId: "destroy-concurrent", idempotencyKey: "destroy-concurrent" };
    const first = driver.destroy({ call, resourceId: "resource" }); await firstEntered.promise;
    const second = driver.destroy({ call, resourceId: "resource" }); const third = driver.destroy({ call, resourceId: "resource" }); releaseFirst.resolve(); await secondEntered.promise;
    await Bun.sleep(25); expect(maximumActive).toBe(1); releaseSecond.resolve();
    expect((await first).receipt.outcome).toBe("unknown"); expect((await second).receipt.outcome).toBe("succeeded"); expect(await third).toEqual(await second); expect(cleanups).toBe(2);
  });
  test("holds the disposal lock until final resource-root deletion settles", async () => {
    const f = await fixture(); class ImmediateCleanup extends WorkspaceImage { override async destroy() {} }
    const driver = new LocalPodmanDriver(f.config, { workspaceImage: new ImmediateCleanup(f.config) }); const roots = (driver as unknown as { roots: ResourceRoot }).roots; const remove = roots.destroy.bind(roots);
    let calls = 0; let active = 0; let maximumActive = 0; const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    roots.destroy = async (resourceId) => { calls++; active++; maximumActive = Math.max(maximumActive, active); try { if (calls === 1) { entered.resolve(); await release.promise; } await remove(resourceId); } finally { active--; } };
    const call = { ...input().call, operationId: "destroy-root-lock", idempotencyKey: "destroy-root-lock" };
    const first = driver.destroy({ call, resourceId: "resource" }); await entered.promise;
    const second = driver.destroy({ call, resourceId: "resource" }); const third = driver.destroy({ call, resourceId: "resource" });
    await Bun.sleep(25); expect({ calls, maximumActive }).toEqual({ calls: 1, maximumActive: 1 }); release.resolve();
    const results = await Promise.all([first, second, third]); expect(results.map((result) => result.receipt.outcome)).toEqual(["succeeded", "succeeded", "succeeded"]); expect(maximumActive).toBe(1);
  });
  test("checks the private state root before trusting destroy recovery records", async () => {
    const f = await fixture(); const call = { ...input().call, operationId: "private-root", idempotencyKey: "private-root" }; const result = { receipt: { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "succeeded" as const }, resource: { resourceId: "resource", desiredState: "destroyed" as const, observedState: "destroyed" as const, limits: { memoryBytes: 1, milliCpu: 1, pids: 1, diskBytes: 1 } } };
    const journal = new DurableOperationJournal(`${f.config.stateRoot}/operations`); await journal.recordDestroyed("resource", call, result); await chmod(f.config.stateRoot, 0o777);
    await expect(new LocalPodmanDriver(f.config).destroy({ call, resourceId: "resource" })).rejects.toThrow("private");
    await chmod(f.config.stateRoot, 0o700); expect((await stat(resourcePaths(f.config.stateRoot, "resource").root)).isDirectory()).toBe(true);
  });
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
      ["PID namespace", (live) => { live.HostConfig.PidMode = "host"; }],
      ["IPC namespace", (live) => { live.HostConfig.IpcMode = "host"; }],
      ["UTS namespace", (live) => { live.HostConfig.UtsMode = "host"; }],
      ["privileged", (live) => { live.HostConfig.Privileged = true; }],
      ["capabilities", (live) => { live.HostConfig.CapDrop = []; }],
      ["security options", (live) => { live.HostConfig.SecurityOpt = []; }],
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
    live.State.Running = true; live.State.Pid = 4242; await writeFile(inspect, JSON.stringify([live]));
    await writeFile(fail, "fail"); const failedInput = { ...input(), call: { ...input().call, operationId: "failed", idempotencyKey: "failed" } }; const failed = await driver.stop(failedInput);
    expect(() => validateProviderMethodExchange("sandbox.lifecycle.v1", "stop", failedInput, failed)).not.toThrow(); expect(JSON.stringify(failed)).not.toContain(root); expect(failed.receipt).toMatchObject({ outcome: "unknown", error: { code: "stopped_unknown", message: "Container stopped outcome is unknown." } });
  });
  test("resolves the persisted container generation before starting a process", async () => {
    const { driver, config, live, inspect } = await fixture(); const roots = new ResourceRoot(config.stateRoot);
    const metadata = await roots.readMetadata<any>("resource"); metadata.state = "running"; metadata.bootId = "boot-id"; await roots.writeMetadata("resource", metadata);
    live.State.Running = true; live.State.Pid = 4242; await writeFile(inspect, JSON.stringify([live]));
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
