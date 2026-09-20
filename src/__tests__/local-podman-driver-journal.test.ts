import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalPodmanDriver } from "../runtime/sandbox/local-podman/driver";
import { DurableOperationJournal } from "../runtime/sandbox/local-podman/journal";
import { ResourceRoot } from "../runtime/sandbox/local-podman/resource-root";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
async function fixture() {
  root = await mkdtemp(`${tmpdir()}/ez-driver-`); const log = `${root}/effects`; const podman = `${root}/podman`;
  await writeFile(podman, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`); await chmod(podman, 0o700);
  const config = { stateRoot: `${root}/state`, imageDigest: `sha256:${"a".repeat(64)}`, podmanPath: podman, fuse2fsPath: "/bin/false", supervisorPath: "/bin/false" };
  await mkdir(config.stateRoot, { recursive: true }); const roots = new ResourceRoot(config.stateRoot); await roots.initialize("resource");
  await roots.writeMetadata("resource", { resourceId: "resource", containerName: "container", state: "stopped", limits: { memoryBytes: 1, milliCpu: 1, pids: 1, diskBytes: 1 } });
  return { driver: new LocalPodmanDriver(config), log, config };
}
const input = () => ({ call: { scope: { projectId: "p", bindingId: "b", generation: 1 }, operationId: "op", idempotencyKey: "key", requestDigest: "a".repeat(64) }, resourceId: "resource" });
describe("local lifecycle journal integration", () => {
  test("replays a completed mutation without another effect", async () => { const { driver, log } = await fixture(); const first = await driver.start(input()); const second = await driver.start(input()); expect(second).toEqual(first); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
  test("recovers pending mutation as unknown without an effect", async () => { const { driver, log, config } = await fixture(); await new DurableOperationJournal(`${config.stateRoot}/operations`).begin(input().call); const result = await driver.start(input()); expect(result.receipt.outcome).toBe("unknown"); await expect(readFile(log, "utf8")).rejects.toThrow(); });
  test("rejects an idempotency collision before an effect", async () => { const { driver, log } = await fixture(); await driver.start(input()); await expect(driver.start({ ...input(), call: { ...input().call, requestDigest: "b".repeat(64) } })).rejects.toThrow("conflicts"); expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1); });
});
