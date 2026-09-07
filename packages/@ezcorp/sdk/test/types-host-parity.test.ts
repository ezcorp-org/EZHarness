import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionManifestV2 as SdkManifest } from "../src/types";
import type { ExtensionManifestV2 as HostManifest } from "../../../../src/extensions/types";

type Assert<T extends true> = T;

// The host may add optional runtime metadata, but both manifest views must
// accept the same author-written declarations.
type _SdkAcceptsHostDeclarations = Assert<HostManifest extends SdkManifest ? true : false>;
type _HostAcceptsSdkDeclarations = Assert<SdkManifest extends HostManifest ? true : false>;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOST_TYPES = readFileSync(join(REPO_ROOT, "src/extensions/types.ts"), "utf8");

test("host uses the SDK declarations and only adds host runtime metadata", () => {
  expect(HOST_TYPES).toContain('from "@ezcorp/sdk"');
  expect(HOST_TYPES).toContain("Host-only MCP launch metadata");
  expect(HOST_TYPES).not.toContain("export interface ToolDefinition {");
});
