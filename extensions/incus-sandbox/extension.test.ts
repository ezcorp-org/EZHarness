import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";
import { SANDBOX_PROVIDER_OPERATIONS } from "@ezcorp/extension-contract";

test("Incus entrypoint serves its validated provider definition", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "incus-sandbox");
  // Preview relays belong to the host registry; the provider must expose every
  // implemented lifecycle/file/process RPC, without advertising endpoint RPCs.
  const required = SANDBOX_PROVIDER_OPERATIONS.filter(operation => !operation.startsWith("endpoints."))
    .map(operation => `incus/${operation.replace(".", "/")}`).sort();
  expect(manifest.methods!.map(method => method.name).sort()).toEqual(required);
  expect(manifest.sandboxProviders?.map(provider => provider.id)).toEqual(["incus"]);
  const provider = manifest.sandboxProviders![0]!;
  expect(provider.capabilities).toEqual(["lifecycle.v1", "files.v1", "processes.v1"]);
  expect(provider.methodGroups![0]?.methods.endpoints).toBeUndefined();
});
