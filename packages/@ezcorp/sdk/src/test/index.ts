import { expect, mock } from "bun:test";
import * as runtime from "../runtime";
export * from "./filesystem";
export { __resetChannelForTests } from "../runtime/channel";
export { __resetLoopsForTests, _getRegisteredLoop, _setStoreFactoryForTests, _setSpawnForTests, _setLoopEventsForTests, _setSettingsResolverForTests, _setProposalClosuresForTests, _setMessagesResolverForTests, _setLlmFactoryForTests, _setCheckFetchForTests } from "../runtime/loop";
export { isUntrustedInputLoop } from "../runtime/loop-core";
export { dispatchAssignmentUpdate } from "../runtime/loop";

const runtimeExports = { ...runtime };

export function restoreModuleMocks(): void {
  mock.restore();
  mock.module("@ezcorp/sdk/runtime", () => runtimeExports);
}

export async function verifyExtensionEntrypoint(load: () => Promise<unknown>, expectedName: string): Promise<void> {
  const sdk = { ...await import("../v4") };
  const definitions: import("../v4").DefinedExtension[] = [];
  mock.module("@ezcorp/sdk/v4", () => ({ ...sdk, serve: async (extension: import("../v4").DefinedExtension) => { definitions.push(extension); } }));
  try {
    await load();
    expect(definitions).toHaveLength(1);
    const extension = definitions[0]!;
    expect(extension.manifest.name).toBe(expectedName);
    expect(extension.manifest.schemaVersion).toBe(4);
    expect(typeof extension.invoke).toBe("function");
    expect(typeof extension.dispatch).toBe("function");
    expect(sdk.validateManifest(extension.manifest)).toEqual(extension.manifest);
  } finally { mock.module("@ezcorp/sdk/v4", () => sdk); }
}
