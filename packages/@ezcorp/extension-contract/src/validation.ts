import Ajv from "ajv";
import { RE2JS } from "re2js";
import schema from "./wire-schema.json";
import type { ExtensionManifestV4, JsonValue, ToolDefinitionV4, ValueSchema, WireData, WorkspaceFiles } from "@ezcorp/extension-contract/types";

export const PROTOCOL_VERSION = 4;
export const VALIDATOR_VERSION = "4.0.0";
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 32;
export const TOOL_RESULT_SCHEMA = {
  type: "object", required: ["content"],
  properties: { content: { type: "array", items: { type: "object", required: ["type"], properties: { type: { type: "string" }, text: { type: "string" } }, additionalProperties: true } }, isError: { type: "boolean" } },
  additionalProperties: true,
};
const encoder = new TextEncoder();
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false });
ajv.addSchema(schema, "wire");

export class ContractError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, message: string, path = "$") {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.path = path;
  }
}

export function assertJson(value: unknown, maxBytes = MAX_FRAME_BYTES): asserts value is JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > MAX_JSON_DEPTH) throw new ContractError("DATA_LIMIT", "JSON structure exceeds limits");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry !== "object" || !entry) throw new ContractError("INVALID_JSON", "Only JSON data is accepted");
    if (seen.has(entry)) throw new ContractError("INVALID_JSON", "Cyclic data is forbidden");
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !("value" in descriptor)) throw new ContractError("INVALID_JSON", "Sparse arrays and accessors are forbidden");
        visit(descriptor.value, depth + 1);
      }
      if (Reflect.ownKeys(entry).length !== entry.length + 1) throw new ContractError("INVALID_JSON", "Array properties are forbidden");
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new ContractError("INVALID_JSON", "Only plain objects are accepted");
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== "string" || forbidden.has(key)) throw new ContractError("INVALID_JSON", "Unsafe object key");
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ContractError("INVALID_JSON", "Accessors and hidden fields are forbidden");
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(entry);
  }
  visit(value, 0);
  if (encoder.encode(JSON.stringify(value)).byteLength > maxBytes) throw new ContractError("DATA_LIMIT", "JSON bytes exceed limit");
}

export function parseJson(text: string, maxBytes = MAX_FRAME_BYTES): JsonValue {
  if (encoder.encode(text).byteLength > maxBytes) throw new ContractError("DATA_LIMIT", "Frame exceeds limit");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ContractError("INVALID_JSON", "Invalid JSON frame"); }
  assertJson(value, maxBytes);
  return value;
}

export function validateWire<Key extends keyof WireData>(kind: Key, value: unknown): WireData[Key] {
  assertJson(value, kind === "buildRequest" || kind === "publishedRelease" ? 128 * 1024 * 1024 : MAX_FRAME_BYTES);
  const validator = ajv.getSchema(`wire#/definitions/WireData/properties/${kind}`);
  if (!validator?.(value)) {
    const issue = validator?.errors?.[0];
    throw new ContractError("INVALID_CONTRACT", `${kind}: ${issue?.message ?? "unsupported schema"}`, issue?.instancePath);
  }
  return value as unknown as WireData[Key];
}

export function validateWorkspacePath(path: string): void {
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.includes(":") || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ContractError("INVALID_PATH", "Expected a bounded relative file path");
  if (path.split("/").some(part => !part || part === "." || part === ".." || forbidden.has(part) || part === "node_modules" || part === ".git")) throw new ContractError("INVALID_PATH", "Unsafe file path");
}

export function validateWorkspaceFiles(value: unknown): WorkspaceFiles {
  return validateFileMap(value, 2000, 20, 128);
}

export function validateArtifactFiles(value: unknown): WorkspaceFiles {
  return validateFileMap(value, 2004, 160, 192);
}

function validateFileMap(value: unknown, maxFiles: number, maxMiB: number, maxSerializedMiB: number): WorkspaceFiles {
  assertJson(value, maxSerializedMiB * 1024 * 1024);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ContractError("INVALID_FILES", "Expected file map");
  const entries = Object.entries(value);
  if (entries.length > maxFiles) throw new ContractError("DATA_LIMIT", `File map exceeds ${maxFiles} files`);
  let totalBytes = 0;
  for (const [path, content] of entries) {
    validateWorkspacePath(path);
    if (typeof content !== "string") throw new ContractError("INVALID_FILES", "File must be text", path);
    totalBytes += encoder.encode(content).byteLength;
    if (totalBytes > maxMiB * 1024 * 1024) throw new ContractError("DATA_LIMIT", `File map exceeds ${maxMiB} MiB`, path);
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) if (Object.hasOwn(value, parts.slice(0, count).join("/"))) throw new ContractError("INVALID_PATH", "File conflicts with directory", path);
  }
  return value as WorkspaceFiles;
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

export function compileValueSchema(value: unknown): (input: unknown) => void {
  assertJson(value, 64 * 1024);
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
      const root = value as Record<string, Record<string, unknown>>;
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
  const expanded = expand(value, new Set(), 0);
  assertJson(expanded, 128 * 1024);
  const linearRegex = Object.assign((pattern: string) => {
    const compiled = RE2JS.compile(pattern);
    return { test: (input: string) => compiled.matcher(input).find() };
  }, { code: "RE2JS.compile" });
  const engine = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: true, formats, code: { regExp: linearRegex } });
  let validate: ReturnType<Ajv["compile"]>;
  try { validate = engine.compile(expanded as ValueSchema); } catch { throw new ContractError("INVALID_SCHEMA", "Invalid JSON Schema"); }
  return (input: unknown) => {
    assertJson(input);
    if (!validate(input)) throw new ContractError("SCHEMA_MISMATCH", validate.errors?.[0]?.message ?? "Value does not match schema", validate.errors?.[0]?.instancePath);
  };
}

export function validateManifest(value: unknown): ExtensionManifestV4 {
  const manifest = validateWire("manifest", value);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new ContractError("INVALID_MANIFEST", "Invalid extension name or version");
  if (manifest.entrypoint) validateWorkspacePath(manifest.entrypoint.replace(/^\.\//, ""));
  const names = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || names.has(tool.name)) throw new ContractError("INVALID_MANIFEST", "Invalid or duplicate tool name");
    names.add(tool.name);
    compileValueSchema(tool.inputSchema);
    compileValueSchema(tool.outputSchema);
    if (tool.mcpOutputSchema) compileValueSchema(tool.mcpOutputSchema);
  }
  if (names.size > 128) throw new ContractError("DATA_LIMIT", "Too many tools");
  const methodNames = new Set<string>();
  for (const method of manifest.methods ?? []) {
    if (!/^[a-zA-Z][a-zA-Z0-9_./:-]{0,127}$/.test(method.name) || method.name.startsWith("extension/") || methodNames.has(method.name)) throw new ContractError("INVALID_MANIFEST", "Invalid or duplicate runtime method");
    methodNames.add(method.name);
    compileValueSchema(method.inputSchema);
    compileValueSchema(method.outputSchema);
  }
  if (methodNames.size > 128) throw new ContractError("DATA_LIMIT", "Too many runtime methods");
  if (manifest.dataSchema) {
    const data = manifest.dataSchema;
    if (![data.version, ...data.readableVersions].every(version => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(version)) || data.readableVersions.length > 64 || new Set(data.readableVersions).size !== data.readableVersions.length || !data.readableVersions.includes(data.version)) throw new ContractError("INVALID_MANIFEST", "Invalid data schema compatibility declaration");
    if (data.migrateMethod && !methodNames.has(data.migrateMethod)) throw new ContractError("INVALID_MANIFEST", "Data migration must reference a declared runtime method");
  }
  for (const route of manifest.permissions.hostApi?.routes ?? []) {
    if (!/^\/api\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(route.path)) throw new ContractError("INVALID_MANIFEST", "Host API routes must be fixed /api paths with named parameters");
  }
  for (const preprocessor of manifest.preprocessors ?? []) if (!names.has(preprocessor.tool) || preprocessor.accepts.length === 0) throw new ContractError("INVALID_MANIFEST", "Preprocessor must reference a declared tool and MIME types");
  if (manifest.smokeTest && !names.has(manifest.smokeTest.tool)) throw new ContractError("INVALID_MANIFEST", "Smoke test must reference a declared tool");
  for (const contributions of [manifest.skills, manifest.pages, manifest.entities, manifest.messageToolbar, manifest.mcpServers]) {
    const identities = new Set<string>();
    for (const item of contributions ?? []) {
      const record = item as unknown as Record<string, unknown>;
      const identity = String(record.name ?? record.id ?? record.type);
      if (!identity || identities.has(identity)) throw new ContractError("INVALID_MANIFEST", "Duplicate contribution identity");
      identities.add(identity);
    }
  }
  const subscriptions = manifest.permissions.eventSubscriptions;
  const events = Array.isArray(subscriptions) ? subscriptions : subscriptions?.events ?? [];
  for (const item of manifest.messageToolbar ?? []) if (!item.event.startsWith(`${manifest.name}:`) || !events.includes(item.event)) throw new ContractError("INVALID_MANIFEST", "Toolbar event must be declared in extension namespace");
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

export async function validatePublishedRelease(value: unknown): Promise<WireData["publishedRelease"]> {
  const release = validateWire("publishedRelease", value);
  const build = release.build;
  if (build.state !== "succeeded" || !build.artifactDigest || !build.manifest || !build.evidence.tests.length || build.evidence.tests.some(test => !test.passed)) throw new ContractError("UNVERIFIED_RELEASE", "Publishing requires a successful tested build");
  validateManifest(build.manifest);
  validateWorkspaceFiles(release.sourceFiles);
  if (!Object.hasOwn(release.sourceFiles, (build.manifest.entrypoint ?? "extension.ts").replace(/^\.\//, ""))) throw new ContractError("UNVERIFIED_RELEASE", "Published source is missing its verified entrypoint");
  if (Object.keys(release.sourceFiles).some(path => path === ".runner" || path.startsWith(".runner/"))) throw new ContractError("INVALID_PATH", "Published source cannot include runner metadata");
  if (await sha256(canonicalJson(release.sourceFiles)) !== build.sourceDigest || await sha256(canonicalJson(build.manifest)) !== build.evidence.discoveryDigest) throw new ContractError("DIGEST_MISMATCH", "Published source or catalog digest mismatch");
  const checksums = Object.fromEntries(await Promise.all(Object.entries(release.sourceFiles).map(async ([path, contents]) => [path, await sha256(contents)])));
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
  const packageChecksums = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([path, contents]) => [path, await sha256(contents)])));
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
