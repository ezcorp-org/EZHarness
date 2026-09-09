/** Source collection treats author metadata as data; it does not evaluate it on the host. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  createInstallerV4SourceTree,
  resetInstallerV4SourceFixture,
  restoreInstallerV4SourceFixture,
  sourceActor,
  stagingCalls,
} from "./helpers/installer-v4-source-fixtures";

const { importExtensionSource } = await import("../extensions/source-import");

afterAll(() => restoreInstallerV4SourceFixture());
beforeEach(resetInstallerV4SourceFixture);

test("bundled source preserves extension and config bytes without evaluating either", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    const result = await importExtensionSource(sourceActor, { kind: "bundled", name: "bundled" });
    const files = stagingCalls().workspace.mock.calls[0]![1].files;

    expect(result.installation.enabled).toBe(false);
    expect(files["extension.ts"]).toContain("source must not execute");
    expect(files["ezcorp.config.ts"]).toContain("metadata must remain source data");
    expect(files[".env"]).toBeUndefined();
    expect(result.openUrl).toBe("/extensions/author?installation=installation&workspace=workspace");
  } finally {
    await tree.cleanup();
  }
});

test("opaque bundled metadata queues a build without an approval or activation side effect", async () => {
  const tree = await createInstallerV4SourceTree();
  try {
    const result = await importExtensionSource(sourceActor, { kind: "bundled", name: "bundled" });
    expect(result.operation.state).toBe("queued");
    expect(stagingCalls().runBuild).toHaveBeenCalledWith(sourceActor, "installation", result.operation.id);
  } finally { await tree.cleanup(); }
});
