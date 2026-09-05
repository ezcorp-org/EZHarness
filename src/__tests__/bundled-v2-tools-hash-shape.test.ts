import { expect, test } from "bun:test";
import { join } from "node:path";
import { validateManifest } from "@ezcorp/extension-contract";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { getProjectRoot } from "../extensions/project-root";
import { digestObject } from "../extensions/v4/blobs";
import { verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";

async function manifest() {
  return discoverFirstPartyManifest(join(getProjectRoot(), "docs/extensions/examples/orchestration"));
}

for (const schemaVersion of [2, 3]) test(`schema ${schemaVersion} stored metadata cannot be silently promoted into a v4 release`, async () => {
  const discovered = await manifest();
  expect(() => validateManifest({ ...discovered, schemaVersion })).toThrow();
  expect(discovered.schemaVersion).toBe(4);
});

test("canonical v4 metadata hashes remain stable across JSON key order", async () => {
  const discovered = await manifest();
  const reversed = Object.fromEntries(Object.entries(discovered).reverse());
  expect(validateManifest(reversed)).toEqual(discovered);
  expect(digestObject(reversed)).toBe(digestObject(discovered));
  expect(discovered.tools?.map((tool) => tool.name).sort()).toEqual(["collect_agent_result", "invoke_agent", "send_to_agent"]);
});

test("a genuine tool catalog change is rejected by real candidate discovery verification", async () => {
  const discovered = await manifest();
  const changed = validateManifest({ ...discovered, tools: [...(discovered.tools ?? []), { ...discovered.tools![0]!, name: "unexpected_tool" }] });
  expect(digestObject(changed)).not.toBe(digestObject(discovered));
  const fixture = releaseRuntimeFixture("orchestration-catalog-fixture", discovered);
  await expect(verifyExtensionCandidate(fixture.runner, { ...fixture.snapshot.release, manifest: changed })).rejects.toMatchObject({ code: "runtime_catalog_mismatch" });
  expect(fixture.calls).toHaveLength(1);
});
