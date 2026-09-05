import { ContractError } from "@ezcorp/extension-contract";
import type { ExtensionManifestV2 } from "./types";

export async function loadManifest(_directory: string): Promise<ExtensionManifestV2> {
  throw new ContractError("EXTENSION_V4_REQUIRED", "Host configuration evaluation is disabled. Discover metadata through an isolated v4 release build.");
}

export const loadManifestFresh = loadManifest;
