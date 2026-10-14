import { describe, expect, test } from "bun:test";
import type { Runner } from "@ezcorp/extension-contract";
import { ExtensionControl } from "../extensions/extension-control";
import type { ExtensionLifecycle } from "../extensions/v4";
import { SHELL_GRANT } from "../extensions/process-spawn-policy";
import { controlActor, controlFixture } from "./helpers/extension-control-fixture";

const stdioRelease = { id: "release", artifactDigest: "a".repeat(64), manifest: { kind: "mcp", mcpServers: [{ name: "files", transport: "stdio" }], permissions: { shell: true } } };
const approval = { id: "approval", releaseId: "release", grants: [SHELL_GRANT] };
// The shell grant decides without reading the artifact, so the runner is never asked.
const runner = { collectArtifacts: async () => { throw new Error("not read"); } } as unknown as Runner;

describe("extensions_inspect carries each approval's process policy", () => {
  test("adds the host's spawn-policy verdict to the state, also when waiting on an operation", async () => {
    const { lifecycle, state } = controlFixture();
    Object.assign(state, { releases: { release: stdioRelease }, approvals: { approval }, operations: { done: { id: "done", state: "verified" } } });
    const control = new ExtensionControl(lifecycle as unknown as ExtensionLifecycle, runner);
    for (const input of [{}, { operationId: "done" }]) {
      const result = await control.execute(controlActor, "extensions_inspect", { installationId: "installation", ...input });
      expect(result).toMatchObject({ installation: state.installation, approvalProcessSpawn: { approval: "allow" } });
    }
  });

  test("without a runner the state is returned as the lifecycle gives it", async () => {
    const { control, state } = controlFixture();
    expect(await control.execute(controlActor, "extensions_inspect", { installationId: "installation" })).toBe(state);
  });
});
