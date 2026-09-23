import Ajv from "ajv";
import { RE2JS } from "re2js";
import schema from "./wire-schema.json";
import type { ExtensionManifestV4, JsonValue, LiveSandboxPresetQualification, LiveSandboxQualificationContext, SandboxCompatibilityObservation, SandboxEffectiveSettings, SandboxPreset, SandboxPresetLimits, SandboxPresetQualification, SandboxPresetResolution, SandboxProviderCapability, SandboxProtocolContribution, SandboxProviderDeclaration, SandboxProviderDescribeResult, SandboxProviderError, SandboxProtocolMethodGroup, ToolDefinitionV4, ValueSchema, WireData, WorkspaceFile, WorkspaceFiles } from "@ezcorp/extension-contract/types";
import { parseTcpDestination } from "./network";
import { assertJson, ContractError, isForbiddenJsonKey, MAX_FRAME_BYTES } from "./json";
import { validateWorkspaceFiles, validateWorkspacePath } from "./files";
export * from "./json";
export * from "./files";

export const PROTOCOL_VERSION = 4;
export const VALIDATOR_VERSION = "4.0.0";
export const SANDBOX_PROFILES = ["linux-exec.v1", "persistent-web-compose.v1"] as const;
export const CANDIDATE_SANDBOX_QUALIFICATION_CASES = ["SP01", "SP02", "SP03", "SP05", "SP07", "SP08"] as const;
export const LIVE_SANDBOX_QUALIFICATION_CASES = ["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08"] as const;
const sandboxProviderMethodDefinitions = {
  describe: ["SandboxProviderDescribeInput", "SandboxProviderDescribeResult"],
  preflight: ["SandboxProviderPreflightInput", "SandboxProviderPreflightResult"],
  "lifecycle.create": ["SandboxProviderCreateInput", "SandboxProviderCreateResult"],
  "lifecycle.inspect": ["SandboxProviderInspectInput", "SandboxProviderInspectResult"],
  "lifecycle.list": ["SandboxProviderListInput", "SandboxProviderListResult"],
  "lifecycle.setPower": ["SandboxProviderSetPowerInput", "SandboxProviderSetPowerResult"],
  "lifecycle.destroy": ["SandboxProviderDestroyInput", "SandboxProviderDestroyResult"],
  "lifecycle.inspectOperation": ["SandboxProviderInspectOperationInput", "SandboxProviderInspectOperationResult"],
  "files.stat": ["SandboxProviderFileStatInput", "SandboxProviderFileStatResult"],
  "files.list": ["SandboxProviderFileListInput", "SandboxProviderFileListResult"],
  "files.readRange": ["SandboxProviderFileReadRangeInput", "SandboxProviderFileReadRangeResult"],
  "files.writeAtomic": ["SandboxProviderFileWriteAtomicInput", "SandboxProviderFileWriteAtomicResult"],
  "files.remove": ["SandboxProviderFileRemoveInput", "SandboxProviderFileRemoveResult"],
  "processes.start": ["SandboxProviderProcessStartInput", "SandboxProviderProcessStartResult"],
  "processes.inspect": ["SandboxProviderProcessInspectInput", "SandboxProviderProcessInspectResult"],
  "processes.readOutput": ["SandboxProviderProcessReadOutputInput", "SandboxProviderProcessReadOutputResult"],
  "processes.cancel": ["SandboxProviderProcessCancelInput", "SandboxProviderProcessCancelResult"],
  "endpoints.open": ["SandboxProviderEndpointOpenInput", "SandboxProviderEndpointOpenResult"],
  "endpoints.close": ["SandboxProviderEndpointCloseInput", "SandboxProviderEndpointCloseResult"],
} as const;
export type SandboxProtocolOperation = keyof typeof sandboxProviderMethodDefinitions;
export type SandboxProviderSchemaDirection = "input" | "result";
export const SANDBOX_PROVIDER_OPERATIONS = Object.freeze(Object.keys(sandboxProviderMethodDefinitions) as SandboxProtocolOperation[]);
export const WORKSPACE_FILE_SCHEMA = { anyOf: [{ type: "string" }, schema.definitions.EncodedWorkspaceFile] };
export const TOOL_RESULT_SCHEMA = {
  type: "object", required: ["content"],
  properties: { content: { type: "array", items: { type: "object", required: ["type"], properties: { type: { type: "string" }, text: { type: "string" } }, additionalProperties: true } }, isError: { type: "boolean" } },
  additionalProperties: true,
};
export type SandboxProviderGroup = "sandbox.lifecycle.v1" | "sandbox.process.v1" | "sandbox.files.v1";
export type ProviderSchemaDirection = "input" | "result";
const providerMethodDefinitions = {
  "sandbox.lifecycle.v1": {
    create: ["SandboxCreateInput", "SandboxCreateResult"], inspect: ["SandboxInspectInput", "SandboxInspectResult"], start: ["SandboxStartInput", "SandboxStartResult"], stop: ["SandboxStopInput", "SandboxStopResult"], destroy: ["SandboxDestroyInput", "SandboxDestroyResult"],
  },
  "sandbox.process.v1": {
    start: ["SandboxProcessStartInput", "SandboxProcessStartResult"], inspect: ["SandboxProcessInspectInput", "SandboxProcessInspectResult"], readOutput: ["SandboxProcessReadOutputInput", "SandboxProcessReadOutputResult"], cancel: ["SandboxProcessCancelInput", "SandboxProcessCancelResult"],
  },
  "sandbox.files.v1": {
    stat: ["SandboxFileStatInput", "SandboxFileStatResult"], list: ["SandboxFileListInput", "SandboxFileListResult"], read: ["SandboxFileReadInput", "SandboxFileReadResult"], write: ["SandboxFileWriteInput", "SandboxFileWriteResult"], mkdir: ["SandboxFileMkdirInput", "SandboxFileMkdirResult"], remove: ["SandboxFileRemoveInput", "SandboxFileRemoveResult"], chmod: ["SandboxFileChmodInput", "SandboxFileChmodResult"],
  },
} as const;
export type SandboxProviderOperation<Group extends SandboxProviderGroup> = keyof typeof providerMethodDefinitions[Group] & string;
const providerSchemaCache = new Map<string, { inputSchema: ValueSchema; outputSchema: ValueSchema }>();

function standaloneWireSchema(definitionName: string): ValueSchema {
  const definitions = schema.definitions as Record<string, ValueSchema>;
  const included = new Map<string, ValueSchema>();
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/definitions/")) {
      const name = decodeURIComponent(record.$ref.slice("#/definitions/".length));
      if (!definitions[name]) throw new ContractError("INVALID_CONTRACT", `Missing provider wire definition: ${name}`);
      if (!included.has(name)) {
        included.set(name, {});
        included.set(name, rewrite(definitions[name]) as ValueSchema);
      }
      return { $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, rewrite(child)]));
  };
  const root = definitions[definitionName];
  if (!root) throw new ContractError("INVALID_CONTRACT", `Missing provider wire definition: ${definitionName}`);
  const rewritten = rewrite(root) as ValueSchema;
  return { ...rewritten, ...(included.size ? { $defs: Object.fromEntries(included) } : {}) };
}

export function providerMethodSchemas<Group extends SandboxProviderGroup>(group: Group, operation: SandboxProviderOperation<Group>): { inputSchema: ValueSchema; outputSchema: ValueSchema } {
  const key = `${group}:${operation}`;
  const cached = providerSchemaCache.get(key);
  if (cached) return structuredClone(cached);
  const pair = (providerMethodDefinitions[group] as Record<string, readonly [string, string]>)[operation];
  if (!pair) throw new ContractError("INVALID_CONTRACT", "Unsupported provider method");
  const value = { inputSchema: standaloneWireSchema(pair[0]), outputSchema: standaloneWireSchema(pair[1]) };
  providerSchemaCache.set(key, value);
  return structuredClone(value);
}
const encoder = new TextEncoder();
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false });
ajv.addSchema(schema, "wire");

export function validateWire<Key extends keyof WireData>(kind: Key, value: unknown): WireData[Key] {
  assertJson(value, kind === "buildRequest" || kind === "publishedRelease" ? 128 * 1024 * 1024 : MAX_FRAME_BYTES);
  const validator = ajv.getSchema(`wire#/definitions/WireData/properties/${kind}`);
  if (!validator?.(value)) {
    const issue = validator?.errors?.[0];
    throw new ContractError("INVALID_CONTRACT", `${kind}: ${issue?.message ?? "unsupported schema"}`, issue?.instancePath);
  }
  return value as unknown as WireData[Key];
}

const schemaKeywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "not", "description", "title", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "pattern", "$ref", "$defs", "definitions"]);
const annotations = new Set(["x-options", "x-shared"]);
const presentationFormats = new Set(["combo-box", "tag-input", "file-path", "search"]);
const formats: Record<string, (value: string) => boolean> = {
  date: value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "date-time": value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)),
  uri: value => { try { return Boolean(new URL(value).protocol); } catch { return false; } },
  email: value => value.length <= 254 && RE2JS.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").matcher(value).find(),
  uuid: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
};
const valueValidators = new Map<string, (input: unknown) => void>();
const maxCachedValidators = 64;
const digestPattern = /^[a-f0-9]{64}$/;
const sandboxIdentityPattern = /^[a-z][a-z0-9-]{0,63}$/;
const sandboxRequirementPattern = /^[a-zA-Z0-9][a-zA-Z0-9._+:/-]{0,127}$/;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const sandboxLimitMaximums: SandboxPresetLimits = {
  memoryBytes: 2 ** 50,
  cpuMillis: 1_000_000,
  pids: 32_768,
  diskBytes: 2 ** 50,
  timeoutMs: 86_400_000,
};
const sandboxContributionFields = ["kind", "protocolMajor", "minimumHostContract", "configSchema", "requiredPermissions", "methodGroups"] as const;
const sandboxStableCapabilities = ["lifecycle.v1", "files.v1", "processes.v1"] as const;
const sandboxProviderCapabilities = [...sandboxStableCapabilities, "endpoints.v1", "snapshot.v1", "restore.v1", "suspend.v1", "pty.v1", "resize.v1"] as const;
const sandboxOperationCapabilities: Partial<Record<SandboxProtocolOperation, SandboxProviderCapability>> = {
  "lifecycle.create": "lifecycle.v1",
  "lifecycle.inspect": "lifecycle.v1",
  "lifecycle.list": "lifecycle.v1",
  "lifecycle.setPower": "lifecycle.v1",
  "lifecycle.destroy": "lifecycle.v1",
  "lifecycle.inspectOperation": "lifecycle.v1",
  "files.stat": "files.v1",
  "files.list": "files.v1",
  "files.readRange": "files.v1",
  "files.writeAtomic": "files.v1",
  "files.remove": "files.v1",
  "processes.start": "processes.v1",
  "processes.inspect": "processes.v1",
  "processes.readOutput": "processes.v1",
  "processes.cancel": "processes.v1",
  "endpoints.open": "endpoints.v1",
  "endpoints.close": "endpoints.v1",
};
const sandboxMutationKinds = {
  "lifecycle.create": "create",
  "lifecycle.setPower": "setPower",
  "lifecycle.destroy": "destroy",
  "files.writeAtomic": "fileWriteAtomic",
  "files.remove": "fileRemove",
  "processes.start": "processStart",
  "processes.cancel": "processCancel",
  "endpoints.open": "endpointOpen",
  "endpoints.close": "endpointClose",
} as const satisfies Partial<Record<SandboxProtocolOperation, string>>;
const sandboxMutationOperations = Object.keys(sandboxMutationKinds) as SandboxProtocolOperation[];
const sandboxProtocolMaximums = {
  listItems: 100,
  pathBytes: 240,
  endpointUrlBytes: 2_048,
  fileChunkBytes: 64 * 1024,
  processOutputBytes: 64 * 1024,
  processOutputChunks: 128,
  environmentEntries: 128,
  environmentBytes: 64 * 1024,
  argvEntries: 256,
  argumentBytes: 16 * 1024,
  processDeadlineMs: 30 * 24 * 60 * 60 * 1_000,
} as const;
const stableIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8Encoder = new TextEncoder();

function sandboxMethodName(methods: SandboxProtocolMethodGroup["methods"], operation: SandboxProtocolOperation): string | undefined {
  if (operation === "describe" || operation === "preflight") return methods[operation];
  const [group, name] = operation.split(".") as ["lifecycle" | "files" | "processes" | "endpoints", string];
  return (methods[group] as Record<string, string> | undefined)?.[name];
}

export function sandboxProviderMethodSchemas(operation: SandboxProtocolOperation): { inputSchema: ValueSchema; outputSchema: ValueSchema } {
  const definitions = sandboxProviderMethodDefinitions[operation];
  if (!definitions) throw new ContractError("INVALID_CONTRACT", "Unsupported sandbox provider method");
  return { inputSchema: standaloneWireSchema(definitions[0]), outputSchema: standaloneWireSchema(definitions[1]) };
}

function requireUniqueBoundedStrings(values: string[], label: string, allowEmpty = false): void {
  if ((!allowEmpty && values.length === 0) || values.length > 16 || new Set(values).size !== values.length || values.some(value => !sandboxRequirementPattern.test(value))) throw new ContractError("INVALID_MANIFEST", `${label} must be a unique bounded list`);
}

function requireSandboxInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new ContractError("INVALID_MANIFEST", `${label} must be a positive bounded integer`);
}

function validateSandboxPresetSemantics(preset: SandboxPreset): void {
  if (!sandboxIdentityPattern.test(preset.id)) throw new ContractError("INVALID_MANIFEST", "Invalid sandbox preset identity");
  for (const [label, digest] of [["image", preset.imageDigest], ["recipe", preset.recipeDigest]] as const) if (!digestPattern.test(digest)) throw new ContractError("INVALID_MANIFEST", `Sandbox ${label} identity must be a lowercase SHA-256 digest`);
  if (preset.helperDigests.length > 16 || new Set(preset.helperDigests).size !== preset.helperDigests.length || preset.helperDigests.some(digest => !digestPattern.test(digest))) throw new ContractError("INVALID_MANIFEST", "Sandbox helper identities must be unique lowercase SHA-256 digests");
  requireSandboxInteger(preset.storage.minimumBytes, "Sandbox storage minimum", sandboxLimitMaximums.diskBytes);
  for (const [name, value] of Object.entries(preset.limits) as [keyof SandboxPresetLimits, number][]) requireSandboxInteger(value, `Sandbox ${name} limit`, sandboxLimitMaximums[name]);
  if (preset.storage.minimumBytes > preset.limits.diskBytes) throw new ContractError("INVALID_MANIFEST", "Sandbox storage minimum exceeds its disk limit");
  requireUniqueBoundedStrings(preset.requirements.backendApis, "Sandbox backend API requirements");
  requireUniqueBoundedStrings(preset.requirements.storageDrivers, "Sandbox storage driver requirements");
  requireUniqueBoundedStrings(preset.requirements.architectures, "Sandbox architecture requirements");
  requireUniqueBoundedStrings(preset.requirements.isolation, "Sandbox isolation requirements");
  for (const [name, bounds] of Object.entries(preset.allowedOverrides) as [keyof SandboxPresetLimits, { minimum: number; maximum: number }][]) {
    requireSandboxInteger(bounds.minimum, `Sandbox ${name} override minimum`, sandboxLimitMaximums[name]);
    requireSandboxInteger(bounds.maximum, `Sandbox ${name} override maximum`, sandboxLimitMaximums[name]);
    if (bounds.minimum > preset.limits[name] || bounds.maximum < preset.limits[name] || bounds.minimum > bounds.maximum) throw new ContractError("INVALID_MANIFEST", `Sandbox ${name} override bounds exclude the preset value`);
    if (name === "diskBytes" && bounds.minimum < preset.storage.minimumBytes) throw new ContractError("INVALID_MANIFEST", "Sandbox disk override minimum is below the storage minimum");
  }
  if (preset.profile === "persistent-web-compose.v1") {
    if (preset.storage.workspace !== "persistent" || preset.network.mode !== "private" || !preset.requirements.nestedCompose) throw new ContractError("INVALID_MANIFEST", "Persistent web Compose presets require persistent storage, private networking, and nested Compose");
  } else if (preset.requirements.nestedCompose) throw new ContractError("INVALID_MANIFEST", "Linux execution presets cannot advertise nested Compose");
}

function hasCompleteSandboxContribution(provider: SandboxProviderDeclaration): provider is SandboxProtocolContribution {
  return sandboxContributionFields.every(field => provider[field] !== undefined);
}

function validateSandboxProviderSemantics(provider: SandboxProviderDeclaration): void {
  if (!sandboxIdentityPattern.test(provider.id)) throw new ContractError("INVALID_MANIFEST", "Invalid sandbox provider identity");
  if (provider.profiles.length === 0 || provider.profiles.length > SANDBOX_PROFILES.length || new Set(provider.profiles).size !== provider.profiles.length) throw new ContractError("INVALID_MANIFEST", "Sandbox provider profiles must be unique and non-empty");
  if (provider.presets.length === 0 || provider.presets.length > 32) throw new ContractError("INVALID_MANIFEST", "Sandbox providers must declare a bounded non-empty preset list");
  const presetIds = new Set<string>();
  const coveredProfiles = new Set<string>();
  for (const preset of provider.presets) {
    if (presetIds.has(preset.id)) throw new ContractError("INVALID_MANIFEST", "Duplicate sandbox preset identity");
    presetIds.add(preset.id);
    if (!provider.profiles.includes(preset.profile)) throw new ContractError("INVALID_MANIFEST", "Sandbox preset uses an unadvertised profile");
    coveredProfiles.add(preset.profile);
    validateSandboxPresetSemantics(preset);
  }
  if (provider.profiles.some(profile => !coveredProfiles.has(profile))) throw new ContractError("INVALID_MANIFEST", "Every advertised sandbox profile requires a preset");

  if (provider.capabilities !== undefined) {
    if (provider.capabilities.length < sandboxStableCapabilities.length || provider.capabilities.length > sandboxProviderCapabilities.length || new Set(provider.capabilities).size !== provider.capabilities.length || provider.capabilities.some(capability => !sandboxProviderCapabilities.includes(capability))) throw new ContractError("INVALID_MANIFEST", "Sandbox provider capabilities must be unique, bounded, and supported");
    if (sandboxStableCapabilities.some(capability => !provider.capabilities!.includes(capability))) throw new ContractError("INVALID_MANIFEST", "Sandbox provider v1 requires lifecycle, files, and processes capabilities");
  }

  const contributionFieldCount = sandboxContributionFields.filter(field => provider[field] !== undefined).length;
  if (contributionFieldCount !== 0 && contributionFieldCount !== sandboxContributionFields.length) throw new ContractError("INVALID_MANIFEST", "Sandbox provider contribution fields must be declared together");
  if (provider.capabilities !== undefined && !hasCompleteSandboxContribution(provider)) throw new ContractError("INVALID_MANIFEST", "Sandbox provider capabilities require a complete contribution");
  if (!hasCompleteSandboxContribution(provider)) return;
  compileValueSchema(provider.configSchema);
  if (provider.configSchema.type !== "object" || provider.configSchema.additionalProperties !== false) throw new ContractError("INVALID_MANIFEST", "Sandbox provider configuration schema must be a closed object");
  if (provider.requiredPermissions.length > 3 || new Set(provider.requiredPermissions).size !== provider.requiredPermissions.length) throw new ContractError("INVALID_MANIFEST", "Sandbox provider permissions must be unique and bounded");
  if (provider.methodGroups.length !== 1 || provider.methodGroups[0]?.name !== "sandbox.provider.v1") throw new ContractError("INVALID_MANIFEST", "Sandbox providers require exactly one sandbox.provider.v1 method group");
  const methods = provider.methodGroups[0].methods;
  const mappedNames = (Object.keys(sandboxProviderMethodDefinitions) as SandboxProtocolOperation[]).map(operation => sandboxMethodName(methods, operation)).filter((name): name is string => name !== undefined);
  if (mappedNames.some(name => !/^[a-zA-Z][a-zA-Z0-9_./:-]{0,127}$/.test(name)) || new Set(mappedNames).size !== mappedNames.length) throw new ContractError("INVALID_MANIFEST", "Sandbox provider methods must be distinct valid runtime method names");
  for (const [group, capability] of [["lifecycle", "lifecycle.v1"], ["files", "files.v1"], ["processes", "processes.v1"], ["endpoints", "endpoints.v1"]] as const) {
    const advertised = provider.capabilities?.includes(capability) ?? false;
    if (Boolean(methods[group]) !== advertised) throw new ContractError("INVALID_MANIFEST", `Sandbox ${group} methods must exactly match the advertised capability`);
  }
}

export function validateSandboxProviderContribution(value: unknown): SandboxProtocolContribution {
  const provider = validateWire("sandboxProvider", value);
  validateSandboxProviderSemantics(provider);
  if (!hasCompleteSandboxContribution(provider)) throw new ContractError("INVALID_MANIFEST", "Sandbox provider contribution is incomplete");
  return provider;
}

function validateSandboxProviders(manifest: ExtensionManifestV4): void {
  if (manifest.sandboxProviders === undefined) return;
  if (manifest.sandboxProviders.length === 0 || manifest.sandboxProviders.length > 16) throw new ContractError("INVALID_MANIFEST", "Sandbox provider declarations must be a non-empty bounded list");
  const providerIds = new Set<string>();
  for (const provider of manifest.sandboxProviders) {
    if (providerIds.has(provider.id)) throw new ContractError("INVALID_MANIFEST", "Duplicate sandbox provider identity");
    providerIds.add(provider.id);
    validateSandboxProviderSemantics(provider);
  }
}

export function compileValueSchema(value: unknown, maxValueBytes = MAX_FRAME_BYTES): (input: unknown) => void {
  assertJson(value, 64 * 1024);
  const cacheKey = `${maxValueBytes}:${canonicalJson(value)}`;
  const cached = valueValidators.get(cacheKey);
  if (cached) { valueValidators.delete(cacheKey); valueValidators.set(cacheKey, cached); return cached; }
  const detached = structuredClone(value);
  let nodes = 0;
  function check(entry: unknown, depth: number): void {
    if (++nodes > 256 || depth > 12) throw new ContractError("SCHEMA_LIMIT", "Schema exceeds complexity limit");
    if (typeof entry === "boolean") return;
    if (!entry || Array.isArray(entry) || typeof entry !== "object") throw new ContractError("INVALID_SCHEMA", "Expected JSON Schema object");
    for (const [key, child] of Object.entries(entry)) {
      if (!schemaKeywords.has(key) && !annotations.has(key) && key !== "format") throw new ContractError("UNSUPPORTED_SCHEMA", `Unsupported JSON Schema keyword: ${key}`);
      if (key === "format" && (typeof child !== "string" || (!Object.hasOwn(formats, child) && !presentationFormats.has(child)))) throw new ContractError("UNSUPPORTED_SCHEMA", "Unsupported schema format");
      if (key === "x-shared" && typeof child !== "string") throw new ContractError("INVALID_SCHEMA", "Shared context annotation must be a name");
      if (key === "x-options" && (!child || typeof child !== "object" || Array.isArray(child))) throw new ContractError("INVALID_SCHEMA", "UI options must be an object");
      if (["properties", "$defs", "definitions"].includes(key)) {
        if (!child || Array.isArray(child) || typeof child !== "object") throw new ContractError("INVALID_SCHEMA", "Invalid properties");
        for (const field of Object.values(child)) check(field, depth + 1);
      } else if (["items", "additionalProperties", "not"].includes(key)) check(child, depth + 1);
      else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(child) || child.length > 16) throw new ContractError("INVALID_SCHEMA", "Invalid schema alternatives");
        for (const alternative of child) check(alternative, depth + 1);
      }
      if (key === "$ref") {
        if (typeof child !== "string" || !/^#\/(?:definitions|\$defs)\/[a-zA-Z0-9_-]+$/.test(child)) throw new ContractError("UNSUPPORTED_SCHEMA", "Only local named schema references are supported");
      }
      if (key === "pattern") {
        if (typeof child !== "string" || child.length > 256) throw new ContractError("SCHEMA_LIMIT", "Pattern exceeds limit");
        try { RE2JS.compile(child); } catch { throw new ContractError("UNSUPPORTED_SCHEMA", "Pattern must use supported RE2 syntax"); }
      }
    }
  }
  check(value, 0);
  let expandedNodes = 0;
  function expand(entry: unknown, visited: Set<string>, depth: number): unknown {
    if (++expandedNodes > 1024 || depth > 16) throw new ContractError("SCHEMA_LIMIT", "Schema reference expansion exceeds limit");
    if (!entry || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(child => expand(child, visited, depth + 1));
    const record = entry as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      if (visited.has(record.$ref)) throw new ContractError("UNSUPPORTED_SCHEMA", "Recursive schemas are not supported");
      const [group, name] = record.$ref.slice(2).split("/");
      const root = detached as Record<string, Record<string, unknown>>;
      const target = root[group!]?.[name!];
      if (!target) throw new ContractError("INVALID_SCHEMA", "Unknown local reference");
      const next = new Set(visited).add(record.$ref);
      const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
      return { allOf: [expand(target, next, depth + 1), expand(siblings, next, depth + 1)] };
    }
    return Object.fromEntries(Object.entries(record).filter(([key, child]) => !["$defs", "definitions"].includes(key) && !annotations.has(key) && !(key === "format" && presentationFormats.has(String(child)))).map(([key, child]) => {
      if (key === "properties") return [key, Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, property]) => [name, expand(property, visited, depth + 1)]))];
      return [key, ["items", "additionalProperties", "not", "anyOf", "oneOf", "allOf"].includes(key) ? expand(child, visited, depth + 1) : child];
    }));
  }
  const expanded = expand(detached, new Set(), 0);
  assertJson(expanded, 128 * 1024);
  const linearRegex = Object.assign((pattern: string) => {
    const compiled = RE2JS.compile(pattern);
    return { test: (input: string) => compiled.matcher(input).find() };
  }, { code: "RE2JS.compile" });
  const engine = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: true, formats, code: { regExp: linearRegex } });
  let validate: ReturnType<Ajv["compile"]>;
  try { validate = engine.compile(expanded as ValueSchema); } catch { throw new ContractError("INVALID_SCHEMA", "Invalid JSON Schema"); }
  const checkValue = (input: unknown) => {
    assertJson(input, maxValueBytes);
    if (!validate(input)) throw new ContractError("SCHEMA_MISMATCH", validate.errors?.[0]?.message ?? "Value does not match schema", validate.errors?.[0]?.instancePath);
  };
  if (valueValidators.size >= maxCachedValidators) valueValidators.delete(valueValidators.keys().next().value!);
  valueValidators.set(cacheKey, checkValue);
  return checkValue;
}

const PROVIDER_CHUNK_BYTES = 256 * 1024;
const PROVIDER_DEADLINE_MS = 24 * 60 * 60 * 1000;
const providerIdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const providerDigestPattern = /^[a-f0-9]{64}$/;

function providerIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || !providerIdentifierPattern.test(value)) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid ${field}`);
}

function providerInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid ${field}`);
}

function providerVirtualPath(value: unknown): void {
  if (typeof value !== "string" || encoder.encode(value).byteLength > 1024 || !value.startsWith("/") || (value.length > 1 && value.endsWith("/")) || value.includes("\\") || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ContractError("INVALID_PROVIDER_PATH", "Expected a canonical workspace-root path");
  if (value !== "/" && value.slice(1).split("/").some(part => !part || part === "." || part === ".." || isForbiddenJsonKey(part))) throw new ContractError("INVALID_PROVIDER_PATH", "Unsafe workspace-root path");
}

function providerEncodedBytes(encoding: unknown, data: unknown): number {
  if (typeof data !== "string") throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid provider byte payload");
  if (encoding === "utf8") return encoder.encode(data).byteLength;
  if (encoding !== "base64" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || (data && btoa(atob(data.slice(-4))) !== data.slice(-4))) throw new ContractError("INVALID_PROVIDER_VALUE", "Expected canonical provider base64");
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

function validateProviderCall(call: Record<string, unknown>): void {
  const scope = call.scope as Record<string, unknown>;
  providerIdentifier(scope.projectId, "project ID");
  providerIdentifier(scope.bindingId, "binding ID");
  providerInteger(scope.generation, "generation", 1);
  providerIdentifier(call.operationId, "operation ID");
  providerIdentifier(call.idempotencyKey, "idempotency key");
  if (typeof call.requestDigest !== "string" || !providerDigestPattern.test(call.requestDigest)) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid request digest");
}

function validateProviderReceipt(receipt: Record<string, unknown>): void {
  providerIdentifier(receipt.operationId, "receipt operation ID");
  providerIdentifier(receipt.idempotencyKey, "receipt idempotency key");
  if (typeof receipt.requestDigest !== "string" || !providerDigestPattern.test(receipt.requestDigest)) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid receipt request digest");
  if (receipt.providerOperationId !== undefined) providerIdentifier(receipt.providerOperationId, "provider operation ID");
  if (receipt.outcome === "failed" && !receipt.error) throw new ContractError("INVALID_PROVIDER_VALUE", "Failed provider receipt requires an error");
  if (receipt.outcome === "succeeded" && receipt.error) throw new ContractError("INVALID_PROVIDER_VALUE", "Successful provider receipt cannot contain an error");
  if (receipt.error) {
    const error = receipt.error as Record<string, unknown>;
    providerIdentifier(error.code, "provider error code");
    if (typeof error.message !== "string" || encoder.encode(error.message).byteLength > 4096) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid provider error message");
  }
}

function validateProviderResource(resource: Record<string, unknown>): void {
  providerIdentifier(resource.resourceId, "resource ID");
  const limits = resource.limits as Record<string, unknown>;
  providerInteger(limits.memoryBytes, "memory bytes", 1);
  providerInteger(limits.milliCpu, "CPU milliCPU", 1, 1_000_000);
  providerInteger(limits.pids, "PID limit", 1, 32_768);
  providerInteger(limits.diskBytes, "disk bytes", 1);
}

function validateProviderProcess(process: Record<string, unknown>): void {
  const identity = process.identity as Record<string, unknown>;
  providerIdentifier(identity.bootId, "boot ID");
  providerIdentifier(identity.processId, "process ID");
  providerInteger(process.outputCursor, "process output cursor");
  if (process.exitCode !== undefined) providerInteger(process.exitCode, "process exit code", -255, 255);
}

function validateProviderFileStat(entry: Record<string, unknown>): void {
  providerVirtualPath(entry.path);
  providerIdentifier(entry.revision, "file revision");
  providerInteger(entry.sizeBytes, "file size");
  providerInteger(entry.mode, "file mode", 0, 0o777);
}

type ProviderRecord = Record<string, unknown>;

function validateLifecycleProviderInput(operation: string, record: ProviderRecord): void {
  if (operation === "create") validateProviderResource({ resourceId: "request", desiredState: "stopped", observedState: "stopped", limits: record.limits });
}

function validateProcessStartArgv(record: ProviderRecord): void {
  const argv = record.argv as unknown[];
  if (argv.length === 0 || argv.length > 128 || argv.some(item => typeof item !== "string" || item.includes("\0") || encoder.encode(item).byteLength > 4096)) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid process argv");
}

function validateProcessStartEnvironment(record: ProviderRecord): void {
  const env = record.env as Record<string, unknown>;
  if (Object.keys(env).length > 128 || Object.entries(env).some(([name, item]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof item !== "string" || item.includes("\0")) || encoder.encode(JSON.stringify(env)).byteLength > 64 * 1024) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid process environment");
}

function validateProcessStartInput(record: ProviderRecord): void {
  validateProcessStartArgv(record);
  validateProcessStartEnvironment(record);
  providerVirtualPath(record.cwd);
  providerInteger(record.timeoutMs, "process timeout", 1, PROVIDER_DEADLINE_MS);
}

function validateProcessOutputInput(record: ProviderRecord): void {
  providerInteger(record.cursor, "process output cursor");
  providerInteger(record.maxBytes, "process output byte limit", 1, PROVIDER_CHUNK_BYTES);
}

function validateProcessProviderInput(operation: string, record: ProviderRecord): void {
  if (record.identity) validateProviderProcess({ identity: record.identity, state: "unknown", outputCursor: 0 });
  if (operation === "start") validateProcessStartInput(record);
  if (operation === "readOutput") validateProcessOutputInput(record);
}

function validateFileProviderInput(operation: string, record: ProviderRecord): void {
  providerVirtualPath(record.path);
  if (record.cursor !== undefined) providerIdentifier(record.cursor, "file list cursor");
  if (record.expectedRevision !== undefined) providerIdentifier(record.expectedRevision, "expected file revision");
  if (record.revision !== undefined) providerIdentifier(record.revision, "file revision");
  fileInputValidators[operation]?.(record);
}

const fileInputValidators: Record<string, ((record: ProviderRecord) => void) | undefined> = {
  list: record => providerInteger(record.limit, "file list limit", 1, 256),
  read: record => {
    providerInteger(record.offsetBytes, "file read offset");
    providerInteger(record.lengthBytes, "file read length", 1, PROVIDER_CHUNK_BYTES);
  },
  write: record => {
    if (providerEncodedBytes(record.encoding, record.data) > PROVIDER_CHUNK_BYTES) throw new ContractError("DATA_LIMIT", "File write exceeds provider chunk limit");
  },
  chmod: record => providerInteger(record.mode, "file mode", 0, 0o777),
};

function validateProviderInput(group: SandboxProviderGroup, operation: string, record: ProviderRecord): void {
  validateProviderCall(record.call as ProviderRecord);
  if (record.resourceId !== undefined) providerIdentifier(record.resourceId, "resource ID");
  if (group === "sandbox.lifecycle.v1") validateLifecycleProviderInput(operation, record);
  if (group === "sandbox.process.v1") validateProcessProviderInput(operation, record);
  if (group === "sandbox.files.v1") validateFileProviderInput(operation, record);
}

function validateProviderResultObjects(record: ProviderRecord): void {
  if (record.resource) validateProviderResource(record.resource as ProviderRecord);
  if (record.process) validateProviderProcess(record.process as ProviderRecord);
  if (record.entry) validateProviderFileStat(record.entry as ProviderRecord);
}

function validateProviderResultEntries(record: ProviderRecord): void {
  if (!record.entries) return;
  const entries = record.entries as unknown[];
  if (entries.length > 256) throw new ContractError("DATA_LIMIT", "File list exceeds provider entry limit");
  for (const entry of entries as ProviderRecord[]) validateProviderFileStat(entry);
}

function validateProviderResultCursors(record: ProviderRecord): void {
  if (record.nextCursor !== undefined) providerIdentifier(record.nextCursor, "next file list cursor");
  if (record.removedRevision !== undefined) providerIdentifier(record.removedRevision, "removed file revision");
}

function validateProviderResultDetails(record: ProviderRecord): void {
  validateProviderResultObjects(record);
  validateProviderResultEntries(record);
  validateProviderResultCursors(record);
}

function validateProcessOutputResult(record: ProviderRecord): void {
  validateProviderProcess({ identity: record.identity, state: "unknown", outputCursor: record.cursor });
  providerInteger(record.cursor, "process output cursor");
  const chunks = record.chunks as unknown[];
  if (chunks.length > 256) throw new ContractError("DATA_LIMIT", "Too many process output chunks");
  let bytes = 0;
  for (const chunk of chunks as ProviderRecord[]) bytes += providerEncodedBytes(chunk.encoding, chunk.data);
  if (bytes > PROVIDER_CHUNK_BYTES) throw new ContractError("DATA_LIMIT", "Process output exceeds provider chunk limit");
}

function validateFileReadResult(record: ProviderRecord): void {
  providerVirtualPath(record.path);
  providerIdentifier(record.revision, "file revision");
  providerInteger(record.offsetBytes, "file read offset");
  providerInteger(record.nextOffsetBytes, "next file read offset");
  if ((record.nextOffsetBytes as number) < (record.offsetBytes as number)) throw new ContractError("INVALID_PROVIDER_VALUE", "Next file read offset cannot move backwards");
  if (providerEncodedBytes(record.encoding, record.data) > PROVIDER_CHUNK_BYTES) throw new ContractError("DATA_LIMIT", "File read exceeds provider chunk limit");
}

function validateProviderResult(group: SandboxProviderGroup, operation: string, record: ProviderRecord): void {
  validateProviderReceipt(record.receipt as ProviderRecord);
  if ((record.receipt as ProviderRecord).outcome !== "succeeded") return;
  validateProviderResultDetails(record);
  if (group === "sandbox.process.v1" && operation === "readOutput") validateProcessOutputResult(record);
  if (group === "sandbox.files.v1" && operation === "read") validateFileReadResult(record);
}

export function validateProviderMethodValue<Group extends SandboxProviderGroup>(group: Group, operation: SandboxProviderOperation<Group>, direction: ProviderSchemaDirection, value: unknown): unknown {
  const schemas = providerMethodSchemas(group, operation);
  compileValueSchema(direction === "input" ? schemas.inputSchema : schemas.outputSchema)(value);
  const record = value as Record<string, unknown>;
  if (direction === "input") {
    validateProviderInput(group, operation, record);
  } else {
    validateProviderResult(group, operation, record);
  }
  return value;
}

function validateProviderReceiptIdentity(call: ProviderRecord, receipt: ProviderRecord): void {
  for (const field of ["operationId", "idempotencyKey", "requestDigest"]) if (call[field] !== receipt[field]) throw new ContractError("INVALID_PROVIDER_RECEIPT", `Provider receipt changed ${field}`);
}

function validateProviderResourceIdentity(request: ProviderRecord, response: ProviderRecord): void {
  if (request.resourceId !== undefined) {
    const resource = response.resource as ProviderRecord | undefined;
    if (resource && request.resourceId !== resource.resourceId) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider response changed resource ID");
  }
}

function validateProviderProcessIdentity(request: ProviderRecord, response: ProviderRecord): void {
  if (request.identity !== undefined) {
    const process = response.process as ProviderRecord | undefined;
    if (process && canonicalJson(request.identity) !== canonicalJson(process.identity)) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider response changed process identity");
  }
}

function validateProcessOutputExchange(request: ProviderRecord, response: ProviderRecord): void {
  if (canonicalJson(request.identity) !== canonicalJson(response.identity)) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider output changed process identity");
  const chunks = response.chunks as ProviderRecord[];
  const bytes = chunks.reduce((total, chunk) => total + providerEncodedBytes(chunk.encoding, chunk.data), 0);
  const requestCursor = request.cursor as number;
  const responseCursor = response.cursor as number;
  const minimumCursor = requestCursor + bytes;
  if (responseCursor < minimumCursor || bytes > (request.maxBytes as number) || (response.gap === false && responseCursor !== minimumCursor)) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider output exceeded its requested cursor or byte range");
}

function validateFileReadIdentity(request: ProviderRecord, response: ProviderRecord): void {
  if (response.path !== request.path || response.offsetBytes !== request.offsetBytes || (request.revision !== undefined && response.revision !== request.revision)) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider read changed path, revision, or offset");
}

function validateFileReadRange(request: ProviderRecord, response: ProviderRecord): void {
  const bytes = providerEncodedBytes(response.encoding, response.data);
  if (bytes > (request.lengthBytes as number) || response.nextOffsetBytes !== (request.offsetBytes as number) + bytes) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider read returned an invalid byte range");
}

function validateFileListExchange(requestedPath: string, response: ProviderRecord): void {
  const prefix = requestedPath === "/" ? "/" : `${requestedPath}/`;
  for (const entry of response.entries as ProviderRecord[]) {
    const path = entry.path as string;
    if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider list returned an entry outside the requested directory");
  }
}

function validateFileEntryPath(requestedPath: string, response: ProviderRecord): void {
  const returnedEntry = response.entry as ProviderRecord | undefined;
  if (returnedEntry && returnedEntry.path !== requestedPath) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider response changed file path");
}

function validateFilesProviderExchange(operation: string, request: ProviderRecord, response: ProviderRecord): void {
  const requestedPath = request.path as string;
  validateFileEntryPath(requestedPath, response);
  if (operation === "list") validateFileListExchange(requestedPath, response);
  if (operation === "read") {
    validateFileReadIdentity(request, response);
    validateFileReadRange(request, response);
  }
  if (operation === "remove" && request.expectedRevision !== undefined && response.removedRevision !== request.expectedRevision) throw new ContractError("INVALID_PROVIDER_RECEIPT", "Provider removal changed the expected revision");
}

function validateSuccessfulProviderExchange(group: SandboxProviderGroup, operation: string, request: ProviderRecord, response: ProviderRecord): void {
  validateProviderResourceIdentity(request, response);
  validateProviderProcessIdentity(request, response);
  if (group === "sandbox.process.v1" && operation === "readOutput") validateProcessOutputExchange(request, response);
  if (group === "sandbox.files.v1") validateFilesProviderExchange(operation, request, response);
}

export function validateProviderMethodExchange<Group extends SandboxProviderGroup>(group: Group, operation: SandboxProviderOperation<Group>, input: unknown, result: unknown): { input: unknown; result: unknown } {
  validateProviderMethodValue(group, operation, "input", input);
  validateProviderMethodValue(group, operation, "result", result);
  const call = (input as { call: Record<string, unknown> }).call;
  const receipt = (result as { receipt: Record<string, unknown> }).receipt;
  validateProviderReceiptIdentity(call, receipt);
  if (receipt.outcome !== "succeeded") return { input, result };
  const request = input as Record<string, unknown>;
  const response = result as Record<string, unknown>;
  validateSuccessfulProviderExchange(group, operation, request, response);
  return { input, result };
}

type ManifestProvider = NonNullable<ExtensionManifestV4["providers"]>[number];
type ManifestMethod = NonNullable<ExtensionManifestV4["methods"]>[number];
type MethodSensitivity = ManifestMethod["sensitivity"];

function validateManifestNetworkPermissions(manifest: ExtensionManifestV4): void {
  const destinations = manifest.permissions.networkTcp;
  if (!destinations) return;
  if (destinations.length > 32 || new Set(destinations).size !== destinations.length) throw new ContractError("INVALID_MANIFEST", "TCP grants must be a unique bounded destination list");
  for (const destination of destinations) parseTcpDestination(destination);
}

function validateManifestSecretPermissions(manifest: ExtensionManifestV4): void {
  const providers = manifest.permissions.secretRead;
  if (!providers) return;
  if (new Set(providers).size !== providers.length || providers.some(name => !["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "GITHUB_TOKEN"].includes(name))) throw new ContractError("INVALID_MANIFEST", "Raw credential grants must name unique supported providers");
}

function validateManifestIdentity(manifest: ExtensionManifestV4): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new ContractError("INVALID_MANIFEST", "Invalid extension name or version");
  if (manifest.entrypoint) validateWorkspacePath(manifest.entrypoint.replace(/^\.\//, ""));
}

function validateManifestTool(tool: ToolDefinitionV4, names: Set<string>): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || names.has(tool.name)) throw new ContractError("INVALID_MANIFEST", "Invalid or duplicate tool name");
  names.add(tool.name);
  compileValueSchema(tool.inputSchema);
  compileValueSchema(tool.outputSchema);
  if (tool.mcpOutputSchema) compileValueSchema(tool.mcpOutputSchema);
}

function validateManifestTools(manifest: ExtensionManifestV4): Set<string> {
  const names = new Set<string>();
  for (const tool of manifest.tools ?? []) validateManifestTool(tool, names);
  if (names.size > 128) throw new ContractError("DATA_LIMIT", "Too many tools");
  return names;
}

function validateManifestMethod(method: ManifestMethod, names: Set<string>): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_./:-]{0,127}$/.test(method.name) || method.name.startsWith("extension/") || names.has(method.name)) throw new ContractError("INVALID_MANIFEST", "Invalid or duplicate runtime method");
  names.add(method.name);
  compileValueSchema(method.inputSchema);
  compileValueSchema(method.outputSchema);
}

function validateManifestMethods(manifest: ExtensionManifestV4): Set<string> {
  const names = new Set<string>();
  for (const method of manifest.methods ?? []) validateManifestMethod(method, names);
  if (names.size > 128) throw new ContractError("DATA_LIMIT", "Too many runtime methods");
  return names;
}

function validateManifestMethodSensitivity(manifest: ExtensionManifestV4, toolNames: Set<string>): Map<string, MethodSensitivity> {
  const sensitivity = new Map((manifest.methods ?? []).map(method => [method.name, method.sensitivity]));
  for (const [method, value] of sensitivity) if (value === "sensitive" && toolNames.has(method)) throw new ContractError("INVALID_MANIFEST", "Sensitive runtime methods cannot be tools");
  return sensitivity;
}

function validateProviderId(provider: ManifestProvider, providerIds: Set<string>): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider.id) || providerIds.has(provider.id)) throw new ContractError("INVALID_MANIFEST", "Invalid or duplicate provider ID");
}

function validateProviderHostAndProfiles(provider: ManifestProvider): void {
  if (provider.minimumHostContract.minor !== 0) throw new ContractError("INVALID_MANIFEST", "Provider minimum host contract must be supported host contract 4.0");
  if (!provider.profiles.length || provider.profiles.length > 8 || new Set(provider.profiles).size !== provider.profiles.length) throw new ContractError("INVALID_MANIFEST", "Provider profiles must be a unique bounded list");
}

function validateProviderCapabilitiesAndGroups(provider: ManifestProvider): void {
  if (provider.capabilities.length > 16 || new Set(provider.capabilities).size !== provider.capabilities.length) throw new ContractError("INVALID_MANIFEST", "Provider capabilities must be a unique bounded list");
  if (!provider.methodGroups.length || provider.methodGroups.length > 16) throw new ContractError("INVALID_MANIFEST", "Provider method groups must be a non-empty bounded list");
}

function validateProviderMetadata(provider: ManifestProvider): void {
  validateProviderHostAndProfiles(provider);
  validateProviderCapabilitiesAndGroups(provider);
  compileValueSchema(provider.configSchema, 64 * 1024);
  if (provider.requiredPermissions.length > 16 || new Set(provider.requiredPermissions).size !== provider.requiredPermissions.length) throw new ContractError("INVALID_MANIFEST", "Provider permissions must be a unique bounded list");
}

function validateProviderPermissions(provider: ManifestProvider, manifest: ExtensionManifestV4): void {
  for (const permission of provider.requiredPermissions) {
    const declaration = manifest.permissions[permission as keyof typeof manifest.permissions];
    const declared = Object.hasOwn(manifest.permissions, permission) && (Array.isArray(declaration) ? declaration.length > 0 : Boolean(declaration));
    if (!declared) throw new ContractError("INVALID_MANIFEST", "Provider required permission must be declared by the manifest");
  }
}

function validateSandboxProviderMethodSchema(group: string, operation: string, mapped: string, manifest: ExtensionManifestV4): void {
  const definitions = (providerMethodDefinitions[group as SandboxProviderGroup] as Record<string, readonly [string, string]>)[operation];
  const method = manifest.methods?.find(candidate => candidate.name === mapped);
  if (!definitions || !method || canonicalJson(method.inputSchema) !== canonicalJson(standaloneWireSchema(definitions[0])) || canonicalJson(method.outputSchema) !== canonicalJson(standaloneWireSchema(definitions[1]))) throw new ContractError("INVALID_MANIFEST", "Sandbox provider methods must use the canonical wire schemas");
}

function validateProviderMethodKind(provider: ManifestProvider, group: string, operation: string, mapped: string, manifest: ExtensionManifestV4, methodSensitivity: Map<string, MethodSensitivity>): void {
  if (provider.kind === "static-secret" && methodSensitivity.get(mapped) !== "sensitive") throw new ContractError("INVALID_MANIFEST", "Secret provider methods must be sensitive");
  if (provider.kind === "sandbox") validateSandboxProviderMethodSchema(group, operation, mapped, manifest);
}

function validateProviderMethodMapping(provider: ManifestProvider, group: string, operation: string, mapped: string, manifest: ExtensionManifestV4, methodNames: Set<string>, methodSensitivity: Map<string, MethodSensitivity>, mappedMethods: Set<string>): void {
  if (!methodNames.has(mapped) || mappedMethods.has(mapped) || !methodSensitivity.get(mapped)) throw new ContractError("INVALID_MANIFEST", "Provider methods must uniquely reference explicitly classified manifest methods");
  mappedMethods.add(mapped);
  validateProviderMethodKind(provider, group, operation, mapped, manifest, methodSensitivity);
}

function validateProviderKindGroups(provider: ManifestProvider, groupNames: Set<string>): void {
  if (provider.kind === "sandbox") {
    for (const required of ["sandbox.lifecycle.v1", "sandbox.process.v1", "sandbox.files.v1"]) if (!groupNames.has(required)) throw new ContractError("INVALID_MANIFEST", "Sandbox providers must declare lifecycle, process, and file method groups");
  } else if (!groupNames.has("secret.static.v1")) throw new ContractError("INVALID_MANIFEST", "Static secret providers must declare the static secret method group");
}

function validateProviderContribution(provider: ManifestProvider, manifest: ExtensionManifestV4, methodNames: Set<string>, methodSensitivity: Map<string, MethodSensitivity>): void {
  validateProviderMetadata(provider);
  validateProviderPermissions(provider, manifest);
  const groupNames = new Set<string>();
  const mappedMethods = new Set<string>();
  for (const group of provider.methodGroups) {
    if (groupNames.has(group.name)) throw new ContractError("INVALID_MANIFEST", "Duplicate provider method group");
    groupNames.add(group.name);
    for (const [operation, mapped] of Object.entries(group.methods)) validateProviderMethodMapping(provider, group.name, operation, mapped, manifest, methodNames, methodSensitivity, mappedMethods);
  }
  validateProviderKindGroups(provider, groupNames);
}

function validateManifestProviders(manifest: ExtensionManifestV4, methodNames: Set<string>, methodSensitivity: Map<string, MethodSensitivity>): void {
  const providerIds = new Set<string>();
  for (const provider of manifest.providers ?? []) {
    validateProviderId(provider, providerIds);
    providerIds.add(provider.id);
    validateProviderContribution(provider, manifest, methodNames, methodSensitivity);
  }
  if (providerIds.size > 16) throw new ContractError("DATA_LIMIT", "Too many provider contributions");
}

function validateDataSchemaCompatibility(data: NonNullable<ExtensionManifestV4["dataSchema"]>): void {
  if (![data.version, ...data.readableVersions].every(version => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(version)) || data.readableVersions.length > 64 || new Set(data.readableVersions).size !== data.readableVersions.length || !data.readableVersions.includes(data.version)) throw new ContractError("INVALID_MANIFEST", "Invalid data schema compatibility declaration");
}

function validateDataSchemaMigration(data: NonNullable<ExtensionManifestV4["dataSchema"]>, methodNames: Set<string>, methodSensitivity: Map<string, MethodSensitivity>): void {
  if (data.migrateMethod && !methodNames.has(data.migrateMethod)) throw new ContractError("INVALID_MANIFEST", "Data migration must reference a declared runtime method");
  if (data.migrateMethod && methodSensitivity.get(data.migrateMethod) === "sensitive") throw new ContractError("INVALID_MANIFEST", "Data migration cannot invoke a sensitive runtime method");
}

function validateManifestDataSchema(manifest: ExtensionManifestV4, methodNames: Set<string>, methodSensitivity: Map<string, MethodSensitivity>): void {
  if (!manifest.dataSchema) return;
  validateDataSchemaCompatibility(manifest.dataSchema);
  validateDataSchemaMigration(manifest.dataSchema, methodNames, methodSensitivity);
}

function validateManifestHostApi(manifest: ExtensionManifestV4): void {
  for (const route of manifest.permissions.hostApi?.routes ?? []) if (!/^\/api\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(route.path)) throw new ContractError("INVALID_MANIFEST", "Host API routes must be fixed /api paths with named parameters");
}

function validateManifestPreprocessors(manifest: ExtensionManifestV4, toolNames: Set<string>): void {
  for (const preprocessor of manifest.preprocessors ?? []) if (!toolNames.has(preprocessor.tool) || preprocessor.accepts.length === 0) throw new ContractError("INVALID_MANIFEST", "Preprocessor must reference a declared tool and MIME types");
}

function validateManifestSmokeTest(manifest: ExtensionManifestV4, toolNames: Set<string>): void {
  if (manifest.smokeTest && !toolNames.has(manifest.smokeTest.tool)) throw new ContractError("INVALID_MANIFEST", "Smoke test must reference a declared tool");
}

function validateManifestContributionGroup(contributions: unknown[] | undefined): void {
  const identities = new Set<string>();
  for (const item of contributions ?? []) {
    const record = item as Record<string, unknown>;
    const identity = String(record.name ?? record.id ?? record.type);
    if (!identity || identities.has(identity)) throw new ContractError("INVALID_MANIFEST", "Duplicate contribution identity");
    identities.add(identity);
  }
}

function validateManifestContributions(manifest: ExtensionManifestV4): void {
  for (const contributions of [manifest.skills, manifest.pages, manifest.entities, manifest.messageToolbar, manifest.mcpServers]) validateManifestContributionGroup(contributions as unknown[] | undefined);
}

function validateManifestToolbar(manifest: ExtensionManifestV4): void {
  const subscriptions = manifest.permissions.eventSubscriptions;
  const events = Array.isArray(subscriptions) ? subscriptions : subscriptions?.events ?? [];
  for (const item of manifest.messageToolbar ?? []) if (!item.event.startsWith(`${manifest.name}:`) || !events.includes(item.event)) throw new ContractError("INVALID_MANIFEST", "Toolbar event must be declared in extension namespace");
}

function validateSandboxProviderManifestSeams(manifest: ExtensionManifestV4, toolNames: Set<string>): void {
  const mappedMethods = new Set<string>();
  const methods = new Map((manifest.methods ?? []).map(method => [method.name, method]));
  for (const provider of manifest.sandboxProviders ?? []) {
    if (!hasCompleteSandboxContribution(provider)) continue;
    for (const permission of provider.requiredPermissions) {
      const declared = permission === "storage"
        ? manifest.permissions.storage === true
        : permission === "networkTcp"
          ? Boolean(manifest.permissions.networkTcp?.length)
          : manifest.permissions.hostApi !== undefined;
      if (!declared) throw new ContractError("INVALID_MANIFEST", `Sandbox provider requires undeclared ${permission} permission`);
    }
    const mappings = provider.methodGroups[0]!.methods;
    for (const operation of SANDBOX_PROVIDER_OPERATIONS) {
      const methodName = sandboxMethodName(mappings, operation);
      if (methodName === undefined) continue;
      const method = methods.get(methodName);
      if (!method || mappedMethods.has(methodName) || toolNames.has(methodName)) {
        throw new ContractError("INVALID_MANIFEST", "Sandbox provider methods must uniquely reference non-tool runtime methods");
      }
      mappedMethods.add(methodName);
      const canonical = sandboxProviderMethodSchemas(operation);
      if (canonicalJson(method.inputSchema) !== canonicalJson(canonical.inputSchema)
        || canonicalJson(method.outputSchema) !== canonicalJson(canonical.outputSchema)) {
        throw new ContractError("INVALID_MANIFEST", "Sandbox provider methods must use the canonical wire schemas");
      }
    }
  }
}

export function validateManifest(value: unknown): ExtensionManifestV4 {
  const manifest = validateWire("manifest", value);
  validateManifestNetworkPermissions(manifest);
  validateManifestSecretPermissions(manifest);
  validateManifestIdentity(manifest);
  const toolNames = validateManifestTools(manifest);
  const methodNames = validateManifestMethods(manifest);
  const methodSensitivity = validateManifestMethodSensitivity(manifest, toolNames);
  validateManifestProviders(manifest, methodNames, methodSensitivity);
  validateSandboxProviders(manifest);
  validateSandboxProviderManifestSeams(manifest, toolNames);
  validateManifestDataSchema(manifest, methodNames, methodSensitivity);
  validateManifestHostApi(manifest);
  validateManifestPreprocessors(manifest, toolNames);
  validateManifestSmokeTest(manifest, toolNames);
  validateManifestContributions(manifest);
  validateManifestToolbar(manifest);
  return manifest;
}

export function validateResourceLimits(value: unknown): WireData["limits"] {
  const limits = validateWire("limits", value);
  for (const [key, limit] of Object.entries(limits)) if (!Number.isSafeInteger(limit) || limit <= 0) throw new ContractError("INVALID_LIMITS", `Invalid resource limit: ${key}`);
  return limits;
}

export function validateInvocationContext(value: unknown): WireData["invocationContext"] {
  const context = validateWire("invocationContext", value);
  for (const [key, entry] of Object.entries(context)) if (!["deadline", "metadata"].includes(key) && (typeof entry !== "string" || !entry.length || entry.length > 4096)) throw new ContractError("INVALID_CONTEXT", `Invalid context field: ${key}`);
  if (!Number.isSafeInteger(context.deadline) || context.deadline <= 0) throw new ContractError("INVALID_CONTEXT", "Invalid invocation deadline");
  return context;
}

export function canonicalJson(value: unknown): string {
  assertJson(value, 192 * 1024 * 1024);
  function encode(entry: JsonValue): string {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`;
    return `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${encode(entry[key]!)}`).join(",")}}`;
  }
  return encode(value);
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function sandboxPresetDigest(preset: SandboxPreset): Promise<string> {
  return sha256(canonicalJson(preset));
}

function validateSandboxCompatibilityObservation(observation: SandboxCompatibilityObservation): void {
  for (const [label, value] of [["backend API", observation.backendApi], ["backend version", observation.backendVersion], ["storage driver", observation.storageDriver]] as const) if (!sandboxRequirementPattern.test(value)) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
}

function requireStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !stableIdPattern.test(value)) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
}

function requireSafeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
}

function requireUtcTimestamp(value: unknown, label: string): asserts value is string {
  const timestamp = typeof value === "string" ? value : "";
  const match = utcTimestampPattern.exec(timestamp);
  const parsed = match ? Date.parse(timestamp) : Number.NaN;
  const date = new Date(parsed);
  const fraction = match?.[7] ?? "";
  if (
    !match
    || !Number.isFinite(parsed)
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
    || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5])
    || date.getUTCSeconds() !== Number(match[6])
    || date.getUTCMilliseconds() !== Number(fraction.padEnd(3, "0") || 0)
  ) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
}

function requireSandboxPath(value: unknown, label: string, rootAllowed = false): asserts value is string {
  if (rootAllowed && value === ".") return;
  if (typeof value !== "string") throw new ContractError("INVALID_PATH", `Invalid sandbox ${label}`);
  validateWorkspacePath(value);
  if (utf8Encoder.encode(value).byteLength > sandboxProtocolMaximums.pathBytes) throw new ContractError("INVALID_PATH", `Sandbox ${label} exceeds its UTF-8 byte bound`);
}

function requireSandboxBasename(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.includes("/")) throw new ContractError("INVALID_PATH", `Invalid sandbox ${label}`);
  requireSandboxPath(value, label);
}

function isDirectChildPath(directory: string, candidate: string): boolean {
  const relative = directory === "." ? candidate : candidate.startsWith(`${directory}/`) ? candidate.slice(directory.length + 1) : "";
  return relative.length > 0 && !relative.includes("/");
}

function base64ByteLength(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !base64Pattern.test(value)) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
  const byteLength = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (!Number.isSafeInteger(byteLength) || byteLength > maximum || (value && btoa(atob(value.slice(-4))) !== value.slice(-4))) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox ${label}`);
  return byteLength;
}

function validateSandboxError(error: SandboxProviderError): void {
  if (utf8Encoder.encode(error.message).byteLength === 0 || utf8Encoder.encode(error.message).byteLength > 1_024) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox provider errors require a bounded message");
  if (error.operationId !== undefined) requireStableId(error.operationId, "error operationId");
  if (error.code === "OUTCOME_UNKNOWN") {
    if (error.operationId === undefined || error.retryable) throw new ContractError("INVALID_PROVIDER_VALUE", "OUTCOME_UNKNOWN requires a stable operation and cannot request a blind retry");
  } else if (error.operationId !== undefined) throw new ContractError("INVALID_PROVIDER_VALUE", "Only OUTCOME_UNKNOWN may carry an unresolved operation");
}

function validateSandboxRequestScope(record: Record<string, unknown>, mutation: boolean): void {
  if (!sandboxIdentityPattern.test(String(record.providerId))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid sandbox providerId");
  requireStableId(record.connectionId, "connectionId");
  requireStableId(record.sandboxId, "sandboxId");
  requireSafeInteger(record.rpcDeadlineMs, "RPC deadline", 1, 8_640_000_000_000_000);
  if (mutation) {
    requireStableId(record.requestId, "requestId");
    requireStableId(record.idempotencyKey, "idempotencyKey");
  }
}

function validateSandboxReceipt(receipt: Record<string, unknown>): void {
  for (const field of ["operationId", "requestId", "idempotencyKey", "sandboxId"] as const) requireStableId(receipt[field], `receipt ${field}`);
  requireUtcTimestamp(receipt.acceptedAt, "receipt acceptedAt");
}

function validateSandboxInspection(sandbox: Record<string, unknown>): void {
  requireStableId(sandbox.sandboxId, "inspection sandboxId");
  requireStableId(sandbox.presetId, "inspection presetId");
  requireSafeInteger(sandbox.generation, "inspection generation", 1);
  if (sandbox.bootId !== null) requireStableId(sandbox.bootId, "inspection bootId");
  requireUtcTimestamp(sandbox.observedAt, "inspection observedAt");
}

function validateFileStat(file: Record<string, unknown>, rootAllowed = false): void {
  requireSandboxPath(file.path, "file path", rootAllowed);
  requireStableId(file.revision, "file revision");
  requireSafeInteger(file.sizeBytes, "file size");
  if (file.kind !== "file" && file.sizeBytes !== 0) throw new ContractError("INVALID_PROVIDER_VALUE", "Non-file entries must report zero bytes");
}

function validateProviderResultRecord(record: Record<string, unknown>): boolean {
  if (record.ok !== false) return true;
  validateSandboxError(record.error as SandboxProviderError);
  return false;
}

function validateSandboxProtocolValue(operation: SandboxProtocolOperation, direction: SandboxProviderSchemaDirection, record: Record<string, unknown>): void {
  if (direction === "result" && !validateProviderResultRecord(record)) {
    if ((record.error as SandboxProviderError).code === "OUTCOME_UNKNOWN" && !sandboxMutationOperations.includes(operation)) throw new ContractError("INVALID_PROVIDER_VALUE", "Only a mutating sandbox operation can have an unknown outcome");
    return;
  }
  if (operation === "describe") {
    if (!sandboxIdentityPattern.test(String(record.providerId))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid described sandbox provider identity");
    if (direction === "result") {
      const profiles = record.profiles as string[];
      const presetIds = record.presetIds as string[];
      const capabilities = record.capabilities as SandboxProviderCapability[] | undefined;
      if (profiles.length === 0 || profiles.length > SANDBOX_PROFILES.length || new Set(profiles).size !== profiles.length || presetIds.length === 0 || presetIds.length > 32 || new Set(presetIds).size !== presetIds.length || presetIds.some(id => !sandboxIdentityPattern.test(id))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid described sandbox profiles or presets");
      if (capabilities !== undefined && (capabilities.length < sandboxStableCapabilities.length || capabilities.length > sandboxProviderCapabilities.length || new Set(capabilities).size !== capabilities.length || capabilities.some(capability => !sandboxProviderCapabilities.includes(capability)) || sandboxStableCapabilities.some(capability => !capabilities.includes(capability)))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid described sandbox capabilities");
    }
    return;
  }
  if (operation === "preflight") {
    if (direction === "input") {
      for (const field of ["providerId", "presetId"] as const) if (!sandboxIdentityPattern.test(String(record[field]))) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox preflight ${field}`);
      requireStableId(record.connectionId, "preflight connectionId");
      for (const field of ["presetDigest", "effectiveSettingsDigest"] as const) if (!digestPattern.test(String(record[field]))) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox preflight ${field}`);
    } else validateSandboxCompatibilityObservation(record.observation as unknown as SandboxCompatibilityObservation);
    return;
  }

  if (operation === "lifecycle.list") {
    if (direction === "input") {
      if (!sandboxIdentityPattern.test(String(record.providerId))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid sandbox providerId");
      requireStableId(record.connectionId, "connectionId");
      requireSafeInteger(record.rpcDeadlineMs, "RPC deadline", 1, 8_640_000_000_000_000);
      requireSafeInteger(record.limit, "list limit", 1, sandboxProtocolMaximums.listItems);
      const cursor = record.cursor as Record<string, unknown> | undefined;
      if (cursor) { requireStableId(cursor.connectionId, "list cursor connectionId"); requireStableId(cursor.afterSandboxId, "list cursor sandboxId"); }
    } else {
      const sandboxes = record.sandboxes as Record<string, unknown>[];
      if (sandboxes.length > sandboxProtocolMaximums.listItems) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox list result exceeds its absolute limit");
      for (const sandbox of sandboxes) validateSandboxInspection(sandbox);
      if (new Set(sandboxes.map(sandbox => sandbox.sandboxId)).size !== sandboxes.length) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox list contains duplicate identities");
      const cursor = record.nextCursor as Record<string, unknown> | undefined;
      if (cursor) { requireStableId(cursor.connectionId, "list cursor connectionId"); requireStableId(cursor.afterSandboxId, "list cursor sandboxId"); }
    }
    return;
  }

  if (direction === "input") validateSandboxRequestScope(record, sandboxMutationOperations.includes(operation));

  if (operation === "lifecycle.create" && direction === "input") {
    requireStableId(record.presetId, "create presetId");
    for (const field of ["presetDigest", "effectiveSettingsDigest"] as const) if (!digestPattern.test(String(record[field]))) throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid sandbox create ${field}`);
  } else if (operation === "lifecycle.inspect" && direction === "result") validateSandboxInspection(record.sandbox as Record<string, unknown>);
  else if ((operation === "lifecycle.setPower" || operation === "lifecycle.destroy") && direction === "input") requireSafeInteger(record.expectedGeneration, "expected generation", 1);
  else if (operation === "lifecycle.inspectOperation") {
    if (direction === "input") requireStableId(record.operationId, "operationId");
    else {
      const inspected = record.operation as Record<string, unknown>;
      requireStableId(inspected.operationId, "operationId");
      requireStableId(inspected.sandboxId, "operation sandboxId");
      if (inspected.resourceId !== null) requireStableId(inspected.resourceId, "operation resourceId");
      requireUtcTimestamp(inspected.startedAt, "operation startedAt");
      if (inspected.finishedAt !== null) requireUtcTimestamp(inspected.finishedAt, "operation finishedAt");
      if (inspected.error !== null) validateSandboxError(inspected.error as SandboxProviderError);
      if (inspected.state === "succeeded" && inspected.error !== null) throw new ContractError("INVALID_PROVIDER_VALUE", "A successful operation cannot carry an error");
      if (inspected.state === "failed" && inspected.error === null) throw new ContractError("INVALID_PROVIDER_VALUE", "A failed operation requires an error");
      if (inspected.state === "outcome_unknown" && (inspected.error as SandboxProviderError | null)?.code !== "OUTCOME_UNKNOWN") throw new ContractError("INVALID_PROVIDER_VALUE", "An unknown operation outcome requires OUTCOME_UNKNOWN");
      if ((inspected.error as SandboxProviderError | null)?.code === "OUTCOME_UNKNOWN" && inspected.state !== "outcome_unknown") throw new ContractError("INVALID_PROVIDER_VALUE", "OUTCOME_UNKNOWN cannot be reported as a known operation state");
      if ((inspected.error as SandboxProviderError | null)?.operationId !== undefined && (inspected.error as SandboxProviderError).operationId !== inspected.operationId) throw new ContractError("INVALID_PROVIDER_VALUE", "Operation error changed operation identity");
      const lifecycleKind = ["create", "setPower", "destroy"].includes(String(inspected.kind));
      if (lifecycleKind !== (inspected.desiredState !== null && inspected.observedState !== null)) throw new ContractError("INVALID_PROVIDER_VALUE", "Desired and observed states are required only for lifecycle operations");
      if (["succeeded", "failed", "cancelled", "outcome_unknown"].includes(String(inspected.state)) !== (inspected.finishedAt !== null)) throw new ContractError("INVALID_PROVIDER_VALUE", "Operation completion time does not match its state");
    }
  } else if (operation.startsWith("files.")) {
    if (direction === "input") {
      requireSandboxPath(record.path, "file path", operation === "files.list" || operation === "files.stat");
      if (operation === "files.list") {
        requireSafeInteger(record.limit, "file list limit", 1, sandboxProtocolMaximums.listItems);
        const cursor = record.cursor as Record<string, unknown> | undefined;
        if (cursor) { requireStableId(cursor.sandboxId, "file cursor sandboxId"); requireStableId(cursor.directoryRevision, "file cursor revision"); requireSandboxBasename(cursor.afterName, "file cursor name"); }
      } else if (operation === "files.readRange") {
        requireStableId(record.revision, "file revision");
        requireSafeInteger(record.offsetBytes, "file range offset");
        requireSafeInteger(record.lengthBytes, "file range length", 1, sandboxProtocolMaximums.fileChunkBytes);
      } else if (operation === "files.writeAtomic") {
        if (record.expectedRevision !== null) requireStableId(record.expectedRevision, "expected file revision");
        requireSafeInteger(record.byteLength, "file byte length", 0, sandboxProtocolMaximums.fileChunkBytes);
        if (base64ByteLength(record.dataBase64, "file data", sandboxProtocolMaximums.fileChunkBytes) !== record.byteLength) throw new ContractError("INVALID_PROVIDER_VALUE", "File byte length does not match its canonical base64 data");
      } else if (operation === "files.remove") requireStableId(record.expectedRevision, "expected file revision");
    } else if (operation === "files.stat") validateFileStat(record.file as Record<string, unknown>, true);
    else if (operation === "files.list") {
      requireStableId(record.directoryRevision, "directory revision");
      const entries = record.entries as Record<string, unknown>[];
      if (entries.length > sandboxProtocolMaximums.listItems) throw new ContractError("INVALID_PROVIDER_VALUE", "File list result exceeds its absolute limit");
      for (const entry of entries) validateFileStat(entry);
      if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new ContractError("INVALID_PROVIDER_VALUE", "File list contains duplicate paths");
      const cursor = record.nextCursor as Record<string, unknown> | undefined;
      if (cursor) { requireStableId(cursor.sandboxId, "file cursor sandboxId"); requireStableId(cursor.directoryRevision, "file cursor revision"); requireSandboxBasename(cursor.afterName, "file cursor name"); }
    } else if (operation === "files.readRange") {
      requireSandboxPath(record.path, "file path");
      requireStableId(record.revision, "file revision");
      requireSafeInteger(record.offsetBytes, "file range offset");
      requireSafeInteger(record.byteLength, "file byte length", 0, sandboxProtocolMaximums.fileChunkBytes);
      if (base64ByteLength(record.dataBase64, "file data", sandboxProtocolMaximums.fileChunkBytes) !== record.byteLength) throw new ContractError("INVALID_PROVIDER_VALUE", "File byte length does not match its canonical base64 data");
    } else if (operation === "files.writeAtomic") {
      requireSandboxPath(record.path, "file path"); requireStableId(record.revision, "file revision"); requireSafeInteger(record.sizeBytes, "file size");
    }
  } else if (operation.startsWith("processes.")) {
    if (operation === "processes.start") {
      if (direction === "input") {
        const argv = record.argv as string[];
        if (argv.length === 0 || argv.length > sandboxProtocolMaximums.argvEntries || argv.some(argument => typeof argument !== "string" || argument.includes("\0") || utf8Encoder.encode(argument).byteLength === 0 || utf8Encoder.encode(argument).byteLength > sandboxProtocolMaximums.argumentBytes) || argv.reduce((bytes, argument) => bytes + utf8Encoder.encode(argument).byteLength, 0) > sandboxProtocolMaximums.environmentBytes) throw new ContractError("INVALID_PROVIDER_VALUE", "Process argv exceeds its bounds");
        requireSandboxPath(record.cwd, "process cwd", true);
        requireStableId(record.user, "process user");
        const env = record.env as Array<Record<string, unknown>>;
        if (env.length > sandboxProtocolMaximums.environmentEntries || new Set(env.map(entry => entry.name)).size !== env.length || env.some(entry => typeof entry.name !== "string" || !environmentNamePattern.test(entry.name) || typeof entry.value !== "string" || entry.value.includes("\0") || utf8Encoder.encode(entry.value).byteLength > sandboxProtocolMaximums.argumentBytes) || env.reduce((bytes, entry) => bytes + utf8Encoder.encode(String(entry.name)).byteLength + utf8Encoder.encode(String(entry.value)).byteLength, 0) > sandboxProtocolMaximums.environmentBytes) throw new ContractError("INVALID_PROVIDER_VALUE", "Process environment exceeds its bounds");
        requireSafeInteger(record.processDeadlineMs, "process deadline", 1, 8_640_000_000_000_000);
        const executionWindow = Number(record.processDeadlineMs) - Number(record.rpcDeadlineMs);
        if (executionWindow < 0 || executionWindow > sandboxProtocolMaximums.processDeadlineMs) throw new ContractError("INVALID_PROVIDER_VALUE", "Process deadline exceeds the allowed execution window");
      } else { requireStableId(record.processId, "processId"); requireStableId(record.bootId, "bootId"); requireUtcTimestamp(record.startedAt, "process startedAt"); }
    } else if (operation === "processes.inspect") {
      if (direction === "input") { requireStableId(record.processId, "processId"); requireStableId(record.bootId, "bootId"); }
      else {
        const process = record.process as Record<string, unknown>;
        for (const field of ["processId", "sandboxId", "bootId"] as const) requireStableId(process[field], `process ${field}`);
        requireUtcTimestamp(process.startedAt, "process startedAt");
        if (process.finishedAt !== null) requireUtcTimestamp(process.finishedAt, "process finishedAt");
        if (process.exitCode !== null) requireSafeInteger(process.exitCode, "process exit code", 0, 255);
        if (process.signal !== null && (typeof process.signal !== "string" || !/^SIG[A-Z0-9]{1,16}$/.test(process.signal))) throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid process signal");
        const terminal = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(process.state));
        if (terminal !== (process.finishedAt !== null) || (!terminal && (process.exitCode !== null || process.signal !== null))) throw new ContractError("INVALID_PROVIDER_VALUE", "Process terminal fields do not match its state");
      }
    } else if (operation === "processes.readOutput") {
      if (direction === "input") {
        requireStableId(record.processId, "processId"); requireStableId(record.bootId, "bootId"); requireSafeInteger(record.maxBytes, "process output bound", 1, sandboxProtocolMaximums.processOutputBytes);
        const cursor = record.cursor as Record<string, unknown>;
        for (const field of ["sandboxId", "processId", "bootId"] as const) requireStableId(cursor[field], `output cursor ${field}`);
        requireSafeInteger(cursor.offsetBytes, "output cursor offset");
      } else {
        const chunks = record.chunks as Array<Record<string, unknown>>;
        if (chunks.length > sandboxProtocolMaximums.processOutputChunks) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output has too many chunks");
        let total = 0;
        for (const chunk of chunks) { requireSafeInteger(chunk.offsetBytes, "output chunk offset"); requireSafeInteger(chunk.byteLength, "output chunk length", 0, sandboxProtocolMaximums.processOutputBytes); const actual = base64ByteLength(chunk.dataBase64, "process output", sandboxProtocolMaximums.processOutputBytes); if (actual !== chunk.byteLength) throw new ContractError("INVALID_PROVIDER_VALUE", "Output byte length does not match its canonical base64 data"); total += actual; }
        if (total > sandboxProtocolMaximums.processOutputBytes) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output exceeds its absolute bound");
        const cursor = record.nextCursor as Record<string, unknown>;
        for (const field of ["sandboxId", "processId", "bootId"] as const) requireStableId(cursor[field], `output cursor ${field}`);
        requireSafeInteger(cursor.offsetBytes, "output cursor offset");
        const gap = record.gap as Record<string, unknown> | undefined;
        if (gap) { requireSafeInteger(gap.fromOffsetBytes, "output gap start"); requireSafeInteger(gap.toOffsetBytes, "output gap end", Number(gap.fromOffsetBytes) + 1); }
      }
    } else if (direction === "input") { requireStableId(record.processId, "processId"); requireStableId(record.bootId, "bootId"); }
  } else if (operation.startsWith("endpoints.")) {
    if (operation === "endpoints.open") {
      if (direction === "input") {
        requireSafeInteger(record.port, "endpoint port", 1, 65_535);
        requireUtcTimestamp(record.expiresAt, "endpoint expiry");
        const lifetime = Date.parse(String(record.expiresAt)) - Number(record.rpcDeadlineMs);
        if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) throw new ContractError("INVALID_PROVIDER_VALUE", "Endpoint expiry must be after the RPC deadline and within 24 hours");
      }
      else {
        requireStableId(record.endpointId, "endpointId"); requireUtcTimestamp(record.expiresAt, "endpoint expiry");
        try {
          if (typeof record.url !== "string" || utf8Encoder.encode(record.url).byteLength > sandboxProtocolMaximums.endpointUrlBytes) throw new Error();
          const endpoint = new URL(record.url);
          if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
        } catch { throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox endpoint URL must be bounded HTTPS without embedded credentials"); }
      }
    } else if (direction === "input") requireStableId(record.endpointId, "endpointId");
  }

  if (direction === "result" && Object.hasOwn(record, "receipt")) validateSandboxReceipt(record.receipt as Record<string, unknown>);
}

export function validateSandboxProviderMethodValue(operation: SandboxProtocolOperation, direction: SandboxProviderSchemaDirection, value: unknown): unknown {
  const schemas = sandboxProviderMethodSchemas(operation);
  compileValueSchema(direction === "input" ? schemas.inputSchema : schemas.outputSchema)(value);
  const record = value as Record<string, unknown>;
  validateSandboxProtocolValue(operation, direction, record);
  return value;
}

export function validateSandboxProviderMethodExchange(operation: SandboxProtocolOperation, inputValue: unknown, resultValue: unknown): { input: unknown; result: unknown } {
  const input = validateSandboxProviderMethodValue(operation, "input", inputValue) as Record<string, unknown>;
  const result = validateSandboxProviderMethodValue(operation, "result", resultValue) as Record<string, unknown>;
  if (operation === "describe" && input.providerId !== result.providerId) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox describe result changed provider identity");
  if (result.ok === false) {
    const error = result.error as SandboxProviderError;
    if (input.operationId !== undefined && error.operationId !== undefined && error.operationId !== input.operationId) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox error changed operation identity");
    return { input, result };
  }
  if (operation === "lifecycle.list") {
    const sandboxes = result.sandboxes as Array<Record<string, unknown>>;
    if (sandboxes.length > Number(input.limit)) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox list exceeded the requested limit");
    const nextCursor = result.nextCursor as Record<string, unknown> | undefined;
    if (nextCursor && (nextCursor.connectionId !== input.connectionId || nextCursor.afterSandboxId !== sandboxes.at(-1)?.sandboxId)) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox list cursor escaped its request scope");
    const cursor = input.cursor as Record<string, unknown> | undefined;
    if (cursor && cursor.connectionId !== input.connectionId) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox list input cursor escaped its connection scope");
  } else if (operation === "lifecycle.inspect" && (result.sandbox as Record<string, unknown>).sandboxId !== input.sandboxId) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox inspection changed sandbox identity");
  else if (operation === "lifecycle.inspectOperation") {
    const inspected = result.operation as Record<string, unknown>;
    if (inspected.operationId !== input.operationId || inspected.sandboxId !== input.sandboxId) throw new ContractError("INVALID_PROVIDER_VALUE", "Operation inspection changed its scoped identity");
  } else if (operation === "files.stat" && (result.file as Record<string, unknown>).path !== input.path) throw new ContractError("INVALID_PROVIDER_VALUE", "File stat changed path identity");
  else if (operation === "files.list") {
    const entries = result.entries as Array<Record<string, unknown>>;
    if (entries.length > Number(input.limit)) throw new ContractError("INVALID_PROVIDER_VALUE", "File list exceeded the requested limit");
    if (entries.some(entry => !isDirectChildPath(String(input.path), String(entry.path)))) throw new ContractError("INVALID_PROVIDER_VALUE", "File list entry escaped its directory scope");
    const inputCursor = input.cursor as Record<string, unknown> | undefined;
    if (inputCursor && (inputCursor.sandboxId !== input.sandboxId || inputCursor.directoryRevision !== result.directoryRevision)) throw new ContractError("INVALID_PROVIDER_VALUE", "File list input cursor escaped its revision scope");
    const nextCursor = result.nextCursor as Record<string, unknown> | undefined;
    if (nextCursor && (nextCursor.sandboxId !== input.sandboxId || nextCursor.directoryRevision !== result.directoryRevision || nextCursor.afterName !== String(entries.at(-1)?.path).split("/").at(-1))) throw new ContractError("INVALID_PROVIDER_VALUE", "File list cursor escaped its revision scope");
  } else if (operation === "files.readRange") {
    if (result.path !== input.path || result.revision !== input.revision || result.offsetBytes !== input.offsetBytes || Number(result.byteLength) > Number(input.lengthBytes)) throw new ContractError("INVALID_PROVIDER_VALUE", "File range result changed its revision-bound request");
  } else if (operation === "files.writeAtomic" && result.path !== input.path) throw new ContractError("INVALID_PROVIDER_VALUE", "Atomic write changed path identity");
  else if (operation === "processes.start") {
    if (result.bootId === undefined || result.processId === undefined) throw new ContractError("INVALID_PROVIDER_VALUE", "Process start omitted its stable identity");
  } else if (operation === "processes.inspect") {
    const process = result.process as Record<string, unknown>;
    if (process.processId !== input.processId || process.bootId !== input.bootId || process.sandboxId !== input.sandboxId) throw new ContractError("INVALID_PROVIDER_VALUE", "Process inspection changed its scoped identity");
  } else if (operation === "processes.readOutput") {
    const cursor = input.cursor as Record<string, unknown>;
    const nextCursor = result.nextCursor as Record<string, unknown>;
    for (const field of ["sandboxId", "processId", "bootId"] as const) if (cursor[field] !== input[field] || nextCursor[field] !== input[field]) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output cursor escaped its process scope");
    if (Number(nextCursor.offsetBytes) < Number(cursor.offsetBytes)) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output cursor moved backwards");
    let expectedOffset = Number(cursor.offsetBytes);
    const gap = result.gap as Record<string, unknown> | undefined;
    if (gap) {
      if (gap.fromOffsetBytes !== cursor.offsetBytes) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output gap does not begin at the requested cursor");
      expectedOffset = Number(gap.toOffsetBytes);
    }
    const chunks = result.chunks as Array<Record<string, unknown>>;
    for (const chunk of chunks) {
      if (Number(chunk.offsetBytes) !== expectedOffset) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output chunks must be contiguous after any explicit gap");
      expectedOffset += Number(chunk.byteLength);
    }
    if (Number(nextCursor.offsetBytes) !== expectedOffset) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output cursor does not follow returned bytes");
    const total = chunks.reduce((bytes, chunk) => bytes + Number(chunk.byteLength), 0);
    if (total > Number(input.maxBytes)) throw new ContractError("INVALID_PROVIDER_VALUE", "Process output exceeded the requested byte bound");
  } else if (operation === "endpoints.open" && result.expiresAt !== input.expiresAt) throw new ContractError("INVALID_PROVIDER_VALUE", "Endpoint result changed the approved expiry");

  const receipt = result.receipt as Record<string, unknown> | undefined;
  const expectedKind = sandboxMutationKinds[operation as keyof typeof sandboxMutationKinds];
  if (receipt && (receipt.kind !== expectedKind || receipt.requestId !== input.requestId || receipt.idempotencyKey !== input.idempotencyKey || receipt.sandboxId !== input.sandboxId)) throw new ContractError("INVALID_PROVIDER_VALUE", "Operation receipt changed the kind or idempotency scope");
  return { input, result };
}

export function sandboxProviderOperationCapability(operation: SandboxProtocolOperation): SandboxProviderCapability | undefined {
  return sandboxOperationCapabilities[operation];
}

export function assertSandboxProviderOperationSupported(descriptionValue: unknown, operation: SandboxProtocolOperation): void {
  const description = validateSandboxProviderMethodValue("describe", "result", descriptionValue) as SandboxProviderDescribeResult;
  const required = sandboxProviderOperationCapability(operation);
  if (required !== undefined && !description.capabilities?.includes(required)) throw new ContractError("UNSUPPORTED_CAPABILITY", `Sandbox provider does not advertise ${required}`);
}

export function validateSandboxProviderDescription(providerValue: unknown, resultValue: unknown): SandboxProviderDescribeResult {
  const provider = validateSandboxProviderContribution(providerValue);
  const result = validateSandboxProviderMethodValue("describe", "result", resultValue) as SandboxProviderDescribeResult;
  const expectedProfiles = [...provider.profiles].sort();
  const expectedPresetIds = provider.presets.map(preset => preset.id).sort();
  const describedProfiles = [...result.profiles].sort();
  const describedPresetIds = [...result.presetIds].sort();
  const expectedCapabilities = provider.capabilities === undefined ? undefined : [...provider.capabilities].sort();
  const describedCapabilities = result.capabilities === undefined ? undefined : [...result.capabilities].sort();
  const capabilitiesMatch = expectedCapabilities === undefined ? describedCapabilities === undefined : describedCapabilities !== undefined && canonicalJson(describedCapabilities) === canonicalJson(expectedCapabilities);
  if (result.providerId !== provider.id || result.protocolMajor !== provider.protocolMajor || canonicalJson(describedProfiles) !== canonicalJson(expectedProfiles) || canonicalJson(describedPresetIds) !== canonicalJson(expectedPresetIds) || !capabilitiesMatch) throw new ContractError("INVALID_PROVIDER_VALUE", "Sandbox provider description does not match its reviewed contribution");
  return result;
}

export function isSandboxPresetCompatible(preset: SandboxPreset, observation: SandboxCompatibilityObservation): boolean {
  validateSandboxPresetSemantics(preset);
  validateSandboxCompatibilityObservation(observation);
  return preset.requirements.backendApis.includes(observation.backendApi)
    && preset.requirements.architectures.includes(observation.architecture)
    && preset.requirements.storageDrivers.includes(observation.storageDriver)
    && preset.requirements.isolation.includes(observation.isolation)
    && (!preset.requirements.nestedCompose || observation.nestedCompose);
}

export async function resolveSandboxPreset(providerValue: unknown, requestValue: unknown): Promise<SandboxPresetResolution> {
  const provider = validateSandboxProviderContribution(providerValue);
  const request = validateWire("sandboxPresetResolutionRequest", requestValue);
  validateSandboxCompatibilityObservation(request.observation);
  const preset = provider.presets.find(candidate => candidate.id === request.presetId);
  if (!preset || preset.profile !== request.profile || !provider.profiles.includes(request.profile)) throw new ContractError("INCOMPATIBLE_PRESET", "Requested sandbox preset and profile do not match the provider declaration");
  if (!isSandboxPresetCompatible(preset, request.observation)) throw new ContractError("INCOMPATIBLE_PRESET", "Sandbox preset is incompatible with the observed backend");
  const limits = { ...preset.limits };
  for (const [name, value] of Object.entries(request.overrides ?? {}) as [keyof SandboxPresetLimits, number][]) {
    const bounds = preset.allowedOverrides[name];
    if (!bounds || !Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) throw new ContractError("INVALID_PRESET_OVERRIDE", `Sandbox ${name} override is not allowed`);
    limits[name] = value;
  }
  const effectiveSettings: SandboxEffectiveSettings = {
    providerId: provider.id,
    presetId: preset.id,
    profile: preset.profile,
    imageDigest: preset.imageDigest,
    recipeDigest: preset.recipeDigest,
    helperDigests: [...preset.helperDigests],
    storage: { ...preset.storage },
    network: { ...preset.network },
    limits,
    observation: { ...request.observation },
  };
  const resolution = {
    presetDigest: await sandboxPresetDigest(preset),
    effectiveSettings,
    effectiveSettingsDigest: await sha256(canonicalJson(effectiveSettings)),
  };
  return validateWire("sandboxPresetResolution", resolution);
}

function validateQualificationTime(verifiedAt: string, validUntil: string, now: number): void {
  const verified = Date.parse(verifiedAt);
  const expiry = Date.parse(validUntil);
  if (!Number.isFinite(now) || !utcTimestampPattern.test(verifiedAt) || !utcTimestampPattern.test(validUntil) || !Number.isFinite(verified) || !Number.isFinite(expiry) || verified > now || expiry <= now || expiry <= verified) throw new ContractError("INVALID_QUALIFICATION", "Sandbox qualification is stale or has an invalid validity interval");
}

function validateQualificationCases(cases: Array<{ caseId: string; status: string }>, required: readonly string[]): void {
  const identities = cases.map(result => result.caseId);
  if (cases.length !== required.length || new Set(identities).size !== identities.length || required.some(caseId => !identities.includes(caseId)) || cases.some(result => result.status !== "passed")) throw new ContractError("INVALID_QUALIFICATION", "Sandbox qualification must contain each required passing case exactly once");
}

function declaredSandboxPresets(manifest: ExtensionManifestV4): Array<{ providerId: string; preset: SandboxPreset }> {
  return (manifest.sandboxProviders ?? []).flatMap(provider => provider.presets.map(preset => ({ providerId: provider.id, preset })));
}

/**
 * Validates host-produced static evidence for every advertised preset. The
 * expected release digest is the stable pre-verification release-input digest,
 * because the stored release digest also covers this evidence.
 */
export async function validateCandidateSandboxPresetQualifications(manifestValue: unknown, qualificationsValue: unknown, expectedReleaseDigest: string, now = Date.now()): Promise<SandboxPresetQualification[]> {
  const manifest = validateManifest(manifestValue);
  if (!digestPattern.test(expectedReleaseDigest)) throw new ContractError("INVALID_QUALIFICATION", "Expected sandbox provider release digest must be lowercase SHA-256");
  const declared = declaredSandboxPresets(manifest);
  const qualifications = qualificationsValue === undefined ? [] : qualificationsValue;
  assertJson(qualifications);
  if (!Array.isArray(qualifications) || qualifications.length !== declared.length) throw new ContractError("INVALID_QUALIFICATION", "Sandbox qualification count does not match declared presets");
  const qualified = new Map<string, SandboxPresetQualification>();
  const validated: SandboxPresetQualification[] = [];
  for (const value of qualifications) {
    const qualification = validateWire("candidateSandboxPresetQualification", value);
    const key = `${qualification.providerId}\u0000${qualification.presetId}`;
    if (qualified.has(key)) throw new ContractError("INVALID_QUALIFICATION", "Duplicate sandbox preset qualification");
    qualified.set(key, qualification);
    validated.push(qualification);
  }
  for (const { providerId, preset } of declared) {
    const qualification = qualified.get(`${providerId}\u0000${preset.id}`);
    if (qualification?.producer !== "host" || qualification.profile !== preset.profile || qualification.releaseDigest !== expectedReleaseDigest || qualification.presetDigest !== await sandboxPresetDigest(preset)) throw new ContractError("INVALID_QUALIFICATION", "Sandbox qualification does not match its provider release and preset");
    validateQualificationTime(qualification.verifiedAt, qualification.validUntil, now);
    validateQualificationCases(qualification.cases, CANDIDATE_SANDBOX_QUALIFICATION_CASES);
  }
  return validated;
}

/** Validates connection-specific evidence before a preset is Ready for use. */
export async function validateLiveSandboxPresetQualification(preset: SandboxPreset, qualificationValue: unknown, context: LiveSandboxQualificationContext): Promise<LiveSandboxPresetQualification> {
  const qualification = validateWire("liveSandboxPresetQualification", qualificationValue);
  if (!sandboxIdentityPattern.test(context.providerId) || !digestPattern.test(context.releaseDigest) || !digestPattern.test(context.effectiveSettingsDigest) || !sandboxRequirementPattern.test(context.connectionId)) throw new ContractError("INVALID_QUALIFICATION", "Invalid expected live sandbox qualification identity");
  if (qualification.producer !== "live-provider" || qualification.providerId !== context.providerId || qualification.connectionId !== context.connectionId || qualification.presetId !== preset.id || qualification.profile !== preset.profile || qualification.releaseDigest !== context.releaseDigest || qualification.presetDigest !== await sandboxPresetDigest(preset) || qualification.effectiveSettingsDigest !== context.effectiveSettingsDigest) throw new ContractError("INVALID_QUALIFICATION", "Live sandbox qualification does not match its connection, release, preset, or settings");
  if (!sandboxRequirementPattern.test(qualification.backendVersion)) throw new ContractError("INVALID_QUALIFICATION", "Invalid live sandbox backend version");
  validateQualificationTime(qualification.verifiedAt, qualification.validUntil, context.now ?? Date.now());
  validateQualificationCases(qualification.cases, LIVE_SANDBOX_QUALIFICATION_CASES);
  return qualification;
}

export async function workspaceFileChecksum(value: WorkspaceFile): Promise<string> {
  return sha256(typeof value === "string" ? value : canonicalJson(value));
}

export async function validatePublishedRelease(value: unknown): Promise<WireData["publishedRelease"]> {
  const release = validateWire("publishedRelease", value);
  const build = release.build;
  if (build.state !== "succeeded" || !build.artifactDigest || !build.manifest || !build.evidence.tests.length || build.evidence.tests.some(test => !test.passed)) throw new ContractError("UNVERIFIED_RELEASE", "Publishing requires a successful tested build");
  validateManifest(build.manifest);
  validateWorkspaceFiles(release.sourceFiles);
  if (!Object.hasOwn(release.sourceFiles, (build.manifest.entrypoint ?? "extension.ts").replace(/^\.\//, ""))) throw new ContractError("UNVERIFIED_RELEASE", "Published source is missing its verified entrypoint");
  if (Object.keys(release.sourceFiles).some(path => path === ".runner" || path.startsWith(".runner/"))) throw new ContractError("INVALID_PATH", "Published source cannot include runner metadata");
  if (await sha256(canonicalJson(release.sourceFiles)) !== build.sourceDigest || await sha256(canonicalJson(build.manifest)) !== build.evidence.discoveryDigest) throw new ContractError("DIGEST_MISMATCH", "Published source or catalog digest mismatch");
  const checksums = Object.fromEntries(await Promise.all(Object.entries(release.sourceFiles).map(async ([path, contents]) => [path, await workspaceFileChecksum(contents)])));
  if (canonicalJson(checksums) !== canonicalJson(release.packageChecksums)) throw new ContractError("DIGEST_MISMATCH", "Published file checksum mismatch");
  const { releaseDigest, ...payload } = release;
  if (await sha256(canonicalJson(payload)) !== releaseDigest) throw new ContractError("DIGEST_MISMATCH", "Published release digest mismatch");
  return release;
}

export async function sealPublishedRelease(build: WireData["buildResult"], artifacts: WorkspaceFiles): Promise<WireData["publishedRelease"]> {
  validateWire("buildResult", build);
  if (await sha256(canonicalJson(artifacts)) !== build.artifactDigest) throw new ContractError("DIGEST_MISMATCH", "Runner artifact digest mismatch");
  const sourceFiles = Object.fromEntries(Object.entries(artifacts).filter(([path]) => !path.startsWith(".runner/")));
  validateWorkspaceFiles(sourceFiles);
  const packageChecksums = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([path, contents]) => [path, await workspaceFileChecksum(contents)])));
  const payload = { schemaVersion: 4 as const, build, sourceFiles, packageChecksums };
  return validatePublishedRelease({ ...payload, releaseDigest: await sha256(canonicalJson(payload)) });
}

export const valueSchemaValidator = {
  getValidator<Result>(schema: Record<string, unknown>) {
    const validate = compileValueSchema(schema);
    return (value: unknown) => {
      try { validate(value); return { valid: true as const, data: value as Result, errorMessage: undefined }; }
      catch { return { valid: false as const, data: undefined, errorMessage: "Value does not match the approved schema" }; }
    };
  },
};

export function normalizeMcpCatalog(value: unknown): ToolDefinitionV4[] {
  assertJson(value);
  if (!Array.isArray(value) || value.length > 128) throw new ContractError("INVALID_MCP", "MCP catalog must contain at most 128 tools");
  const names = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContractError("INVALID_MCP", "Invalid MCP tool");
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || names.has(tool.name)) throw new ContractError("INVALID_MCP", "Invalid or duplicate MCP tool name");
    names.add(tool.name);
    compileValueSchema(tool.inputSchema);
    if (tool.outputSchema) compileValueSchema(tool.outputSchema);
    const description = tool.description ?? tool.title ?? tool.name;
    if (typeof description !== "string") throw new ContractError("INVALID_MCP", "Invalid MCP tool description");
    return { name: tool.name, description, inputSchema: tool.inputSchema as ValueSchema, outputSchema: TOOL_RESULT_SCHEMA, ...(tool.outputSchema ? { mcpOutputSchema: tool.outputSchema as ValueSchema } : {}) };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
