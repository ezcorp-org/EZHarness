import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("multi-agent-orchestrator registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "multi-agent-orchestrator");
  expect(manifest).toMatchObject({ name: "multi-agent-orchestrator", schemaVersion: 4 });
});
