import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import type {
  AgentComponentDefinition as SdkAgent,
  CapabilityDeclaration as SdkCapabilities,
  DependencySpec as SdkDependency,
  ExtensionManifestV2 as SdkManifest,
  ExtensionPageDeclaration as SdkPage,
  McpServerStdio as SdkMcpStdio,
  McpTransport as SdkMcpTransport,
  MessageToolbarItem as SdkToolbar,
  PreprocessorDecl as SdkPreprocessor,
  ScriptDefinition as SdkScripts,
  SettingsField as SdkSettingsField,
  SettingsSchema as SdkSettings,
  SkillDefinition as SdkSkill,
  ToolDefinition as SdkTool,
} from "../src/types";
import type {
  AgentComponentDefinition as HostAgent,
  CapabilityDeclaration as HostCapabilities,
  DependencySpec as HostDependency,
  ExtensionManifestV2 as HostManifest,
  ExtensionPageDeclaration as HostPage,
  McpServerStdio as HostMcpStdio,
  McpTransport as HostMcpTransport,
  MessageToolbarItem as HostToolbar,
  PreprocessorDecl as HostPreprocessor,
  ScriptDefinition as HostScripts,
  SettingsField as HostSettingsField,
  SettingsSchema as HostSettings,
  SkillDefinition as HostSkill,
  ToolDefinition as HostTool,
} from "../../../../src/extensions/types";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// These checks fail at compile time if the host stops re-exporting an author
// declaration, narrows the legacy SDK surface, or drops its separate v4
// runtime manifest support.
type _Tool = Assert<Equal<SdkTool, HostTool>>;
type _Skill = Assert<Equal<SdkSkill, HostSkill>>;
type _Capabilities = Assert<Equal<SdkCapabilities, HostCapabilities>>;
type _Preprocessor = Assert<Equal<SdkPreprocessor, HostPreprocessor>>;
type _Agent = Assert<Equal<SdkAgent, HostAgent>>;
type _Scripts = Assert<Equal<SdkScripts, HostScripts>>;
type _Dependency = Assert<Equal<SdkDependency, HostDependency>>;
type _SettingsField = Assert<Equal<SdkSettingsField, HostSettingsField>>;
type _Settings = Assert<Equal<SdkSettings, HostSettings>>;
type _Toolbar = Assert<Equal<SdkToolbar, HostToolbar>>;
type _Page = Assert<Equal<SdkPage, HostPage>>;
type _McpTransport = Assert<Equal<SdkMcpTransport, HostMcpTransport>>;
type _AuthorManifestFitsHost = Assert<SdkManifest extends HostManifest ? true : false>;
type _V4ManifestFitsHost = Assert<ExtensionManifestV4 extends HostManifest ? true : false>;
type _HostRetainsSdkVersions = Assert<
  Equal<Exclude<HostManifest["schemaVersion"], 4>, SdkManifest["schemaVersion"]>
>;
type _HostAddsOnlyV4 = Assert<Equal<HostManifest["schemaVersion"], SdkManifest["schemaVersion"] | 4>>;
type _SdkDoesNotClaimV4 = Assert<Equal<Extract<SdkManifest["schemaVersion"], 4>, never>>;
type _AuthorMcpDoesNotExposeHostFd = Assert<Equal<Extract<keyof SdkMcpStdio, "seccompFd">, never>>;
type _HostMcpRetainsFd = Assert<"seccompFd" extends keyof HostMcpStdio ? true : false>;
type _TypoIsNotAnAuthorField = Assert<Equal<Extract<keyof SdkManifest, "permssions">, never>>;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOST_TYPES = readFileSync(join(REPO_ROOT, "src/extensions/types.ts"), "utf8");

const reexportBlock = HOST_TYPES.match(/export type \{([\s\S]*?)\} from "@ezcorp\/sdk";/)?.[1];
const AUTHOR_TYPE_REEXPORTS = [
  "AgentComponentDefinition", "CapabilityDeclaration", "DependencySpec",
  "ExtensionPageDeclaration", "McpTransport", "MessageToolbarItem",
  "PreprocessorDecl", "ScriptDefinition", "SettingsField",
  "SettingsFieldBoolean", "SettingsFieldNumber", "SettingsFieldSecret",
  "SettingsFieldSelect", "SettingsFieldText", "SettingsSchema",
  "SkillDefinition", "ToolDefinition",
] as const;
const AUTHOR_TYPE_REEXPORT_CASES = AUTHOR_TYPE_REEXPORTS.map((name) => [name] as const);

describe("SDK/host author declaration parity", () => {
  test("host imports the author manifest from the SDK", () => {
    expect(HOST_TYPES).toContain('ExtensionManifestV2 as AuthorExtensionManifestV2');
  });

  test.each(AUTHOR_TYPE_REEXPORT_CASES)("re-exports %s", (name) => {
    expect(reexportBlock).toMatch(new RegExp(`\\b${name}\\b`));
  });

  test("host-only MCP launch fields stay outside the SDK type", () => {
    expect(HOST_TYPES).toContain("Host-only MCP launch metadata");
    expect(HOST_TYPES).toContain("seccompFd?: number | null");
    expect(HOST_TYPES).toContain("onChildSpawned?:");
    expect(HOST_TYPES).toContain("_internal_vethSetup?:");
  });

  test("the host manifest composes author permissions with internal metadata", () => {
    expect(HOST_TYPES).toContain('"mcpServers" | "permissions"');
    expect(HOST_TYPES).toContain("mcpInvoke?: boolean");
    expect(HOST_TYPES).toContain("drafts?: { kinds: string[] }");
  });
});
