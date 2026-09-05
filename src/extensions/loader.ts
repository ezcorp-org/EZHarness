import { ContractError } from "@ezcorp/extension-contract";
import type { ExtensionManifestV2 } from "./types";

export function extensionV4Required(): ContractError {
  return new ContractError("EXTENSION_V4_REQUIRED", "Host configuration evaluation is disabled. Import source into a workspace, build and inspect an isolated v4 release, then obtain human approval before activation.");
}

export async function loadManifest(_directory: string): Promise<ExtensionManifestV2> {
  throw extensionV4Required();
}

export const loadManifestFresh = loadManifest;
