import { inferPackageType } from "./types";
import type { SettingsField } from "./types";
export { inferPackageType };

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// Manifest name constraints: must be filesystem-safe so the installer can use
// it as a directory name under data/extensions/<name> without any caller
// needing to sanitize. Rejects path separators (`/`, `\`), traversal (`..`),
// leading dots, and length > 64.
const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

// RFC 6838 token chars for type-name and subtype-name: alphanumeric start,
// then alphanumeric or any of ! # $ & - ^ _ . + . Exactly one slash. No
// whitespace, no traversal-friendly chars.
const MIME_REGEX = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

// ── Component Validators ─────────────────────────────────────────

function validateToolsArray(tools: unknown, errors: string[]): void {
  if (!Array.isArray(tools)) {
    errors.push("tools must be an array");
    return;
  }
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as Record<string, unknown>;
    if (!t || typeof t !== "object") {
      errors.push(`tools[${i}] must be an object`);
      continue;
    }
    if (!t.name || typeof t.name !== "string")
      errors.push(`tools[${i}].name is required`);
    if (!t.description || typeof t.description !== "string")
      errors.push(`tools[${i}].description is required`);
    if (!t.inputSchema || typeof t.inputSchema !== "object")
      errors.push(`tools[${i}].inputSchema is required`);
  }
}

function validateSkillsArray(skills: unknown, errors: string[]): void {
  if (!Array.isArray(skills)) {
    errors.push("skills must be an array");
    return;
  }
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i] as Record<string, unknown>;
    if (!s || typeof s !== "object") {
      errors.push(`skills[${i}] must be an object`);
      continue;
    }
    if (!s.name || typeof s.name !== "string")
      errors.push(`skills[${i}].name is required`);
    if (!s.description || typeof s.description !== "string")
      errors.push(`skills[${i}].description is required`);
  }
}

const MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);

function validateMcpServersArray(
  mcpServers: unknown,
  errors: string[],
): void {
  if (!Array.isArray(mcpServers)) {
    errors.push("mcpServers must be an array");
    return;
  }
  for (let i = 0; i < mcpServers.length; i++) {
    const m = mcpServers[i] as Record<string, unknown>;
    if (!m || typeof m !== "object") {
      errors.push(`mcpServers[${i}] must be an object`);
      continue;
    }
    if (!m.name || typeof m.name !== "string")
      errors.push(`mcpServers[${i}].name is required`);
    if (typeof m.transport !== "string" || !MCP_TRANSPORTS.has(m.transport)) {
      errors.push(`mcpServers[${i}].transport must be one of stdio|http|sse`);
      continue;
    }
    if (m.transport === "stdio") {
      if (!m.command || typeof m.command !== "string")
        errors.push(`mcpServers[${i}].command is required for stdio transport`);
      if (m.args !== undefined && !Array.isArray(m.args))
        errors.push(`mcpServers[${i}].args must be an array of strings`);
      if (m.env !== undefined && (typeof m.env !== "object" || Array.isArray(m.env)))
        errors.push(`mcpServers[${i}].env must be an object`);
    } else {
      if (!m.url || typeof m.url !== "string")
        errors.push(`mcpServers[${i}].url is required for ${m.transport} transport`);
      if (m.headers !== undefined && (typeof m.headers !== "object" || Array.isArray(m.headers)))
        errors.push(`mcpServers[${i}].headers must be an object`);
    }
  }
}

/**
 * Extra checks for manifests declaring `kind: "mcp"`. Ensures a single
 * server entry, no packaged entrypoint, and no subprocess-style permission
 * claims that make no sense for a connection-based extension.
 */
export function validateMcpManifest(
  data: unknown,
): { valid: boolean; errors: string[] } {
  const base = validateManifestV2(data);
  if (!data || typeof data !== "object") return base;
  const m = data as Record<string, unknown>;
  const errors = [...base.errors];
  if (m.kind !== "mcp") errors.push(`kind must be "mcp"`);
  if (!Array.isArray(m.mcpServers) || m.mcpServers.length !== 1)
    errors.push("mcp manifests must declare exactly one mcpServers entry");
  if (m.entrypoint) errors.push("mcp manifests must not set entrypoint");
  return { valid: errors.length === 0, errors };
}

function validateAgentComponent(agent: unknown, errors: string[]): void {
  if (!agent || typeof agent !== "object") {
    errors.push("agent must be an object");
    return;
  }
  const a = agent as Record<string, unknown>;
  if (!a.prompt || typeof a.prompt !== "string")
    errors.push("agent.prompt is required");
}

function validateScriptsBlock(scripts: unknown, errors: string[]): void {
  if (!scripts || typeof scripts !== "object") {
    errors.push("scripts must be an object");
  }
}

// Mirrors the dispatcher constraint that an extension can only declare
// events in its own namespace (`event-subscription-dispatcher.ts:registerExtension`).
// The id charset is filesystem-safe and predictable for test-id selectors.
const MSG_TOOLBAR_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MSG_TOOLBAR_APPLIES_TO = new Set(["user", "assistant", "both"]);
// `appliesToSelection` opts a contribution into the multi-select bulk
// action bar. Default ("single") preserves pre-bulk behavior.
const MSG_TOOLBAR_APPLIES_TO_SELECTION = new Set(["single", "bulk", "both"]);

function validateMessageToolbarArray(
  manifestName: string,
  items: unknown,
  declaredEventSubs: readonly string[],
  errors: string[],
): void {
  if (!Array.isArray(items)) {
    errors.push("messageToolbar must be an array");
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Record<string, unknown>;
    if (!it || typeof it !== "object") {
      errors.push(`messageToolbar[${i}] must be an object`);
      continue;
    }
    if (typeof it.id !== "string" || !MSG_TOOLBAR_ID_REGEX.test(it.id)) {
      errors.push(
        `messageToolbar[${i}].id must match /^[a-z0-9][a-z0-9-]{0,31}$/`,
      );
    } else if (seenIds.has(it.id)) {
      errors.push(`messageToolbar[${i}].id "${it.id}" is duplicated`);
    } else {
      seenIds.add(it.id);
    }
    if (!it.icon || typeof it.icon !== "string")
      errors.push(`messageToolbar[${i}].icon is required and must be a string`);
    if (!it.tooltip || typeof it.tooltip !== "string")
      errors.push(
        `messageToolbar[${i}].tooltip is required and must be a string`,
      );
    if (
      it.appliesTo !== undefined &&
      (typeof it.appliesTo !== "string" ||
        !MSG_TOOLBAR_APPLIES_TO.has(it.appliesTo))
    ) {
      errors.push(
        `messageToolbar[${i}].appliesTo must be one of "user"|"assistant"|"both"`,
      );
    }
    if (
      it.appliesToSelection !== undefined &&
      (typeof it.appliesToSelection !== "string" ||
        !MSG_TOOLBAR_APPLIES_TO_SELECTION.has(it.appliesToSelection))
    ) {
      errors.push(
        `messageToolbar[${i}].appliesToSelection must be one of "single"|"bulk"|"both"`,
      );
    }
    if (typeof it.event !== "string" || it.event.length === 0) {
      errors.push(`messageToolbar[${i}].event is required and must be a string`);
    } else {
      const expectedPrefix = `${manifestName}:`;
      if (!it.event.startsWith(expectedPrefix)) {
        errors.push(
          `messageToolbar[${i}].event must be prefixed with "${expectedPrefix}" (event-subscription-dispatcher namespace rule)`,
        );
      }
      if (!declaredEventSubs.includes(it.event)) {
        errors.push(
          `messageToolbar[${i}].event "${it.event}" must also be listed in permissions.eventSubscriptions`,
        );
      }
    }
  }
}

// Settings keys are used as filesystem-safe identifiers and as JS-object
// keys exposed to extension authors — keep them lowercase, no traversal,
// no leading digit/underscore.
const SETTINGS_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const SETTINGS_FIELD_TYPES = new Set(["select", "text", "number", "boolean"]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// ── Shared per-rule predicates ────────────────────────────────────
// These helpers are the single source of truth for "is this value
// acceptable for this field?". Both admit-time (granular error
// emission) and clamp-time (`isValidForField` → drop on false) consume
// them, so the validity rule set lives in exactly one place.

function selectValueAccepted(
  options: readonly { value: string }[],
  value: unknown,
): boolean {
  return typeof value === "string" && options.some((o) => o.value === value);
}

function textLengthMinOk(field: { minLength?: number }, len: number): boolean {
  return field.minLength === undefined || len >= field.minLength;
}

function textLengthMaxOk(field: { maxLength?: number }, len: number): boolean {
  return field.maxLength === undefined || len <= field.maxLength;
}

/** Returns null if pattern is unset OR malformed; the regex otherwise.
 *  Clamp-time treats malformed-pattern as "drop the value"; admit-time
 *  emits a separate `pattern is not a valid regex` error already, so a
 *  text default whose pattern is malformed is moot at admit-time. */
function compileTextPattern(field: { pattern?: string }): RegExp | null {
  if (field.pattern === undefined || typeof field.pattern !== "string") return null;
  try {
    return new RegExp(field.pattern);
  } catch {
    return null;
  }
}

function numberMinOk(field: { min?: number }, value: number): boolean {
  return field.min === undefined || value >= field.min;
}

function numberMaxOk(field: { max?: number }, value: number): boolean {
  return field.max === undefined || value <= field.max;
}

function numberIntegerOk(field: { integer?: boolean }, value: number): boolean {
  return field.integer !== true || Number.isInteger(value);
}

/**
 * Single-bool validity check used at clamp-time (`coerceValue`) and as
 * the conjunctive sanity gate at admit-time. Mirrors the per-rule
 * predicates above — keep them in sync if the rule set changes.
 */
export function isValidForField(field: SettingsField, value: unknown): boolean {
  switch (field.type) {
    case "select":
      return selectValueAccepted(field.options, value);
    case "text": {
      if (typeof value !== "string") return false;
      if (!textLengthMinOk(field, value.length)) return false;
      if (!textLengthMaxOk(field, value.length)) return false;
      if (field.pattern !== undefined) {
        const re = compileTextPattern(field);
        if (!re || !re.test(value)) return false;
      }
      return true;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (!numberMinOk(field, value)) return false;
      if (!numberMaxOk(field, value)) return false;
      if (!numberIntegerOk(field, value)) return false;
      return true;
    }
    case "boolean":
      return typeof value === "boolean";
  }
}

function validateSelectField(
  path: string,
  field: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(field.options) || field.options.length === 0) {
    errors.push(`${path}.options must be a non-empty array`);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < field.options.length; i++) {
    const opt = field.options[i] as Record<string, unknown> | null;
    if (!opt || typeof opt !== "object") {
      errors.push(`${path}.options[${i}] must be an object`);
      continue;
    }
    if (typeof opt.value !== "string") {
      errors.push(`${path}.options[${i}].value must be a string`);
    } else if (seen.has(opt.value)) {
      errors.push(`${path}.options[${i}].value "${opt.value}" is duplicated`);
    } else {
      seen.add(opt.value);
    }
    if (typeof opt.label !== "string") {
      errors.push(`${path}.options[${i}].label must be a string`);
    }
  }
  if (field.default !== undefined) {
    if (typeof field.default !== "string") {
      errors.push(`${path}.default must be a string`);
    } else {
      const optionsTyped = (field.options as { value: string }[]).filter(
        (o) => o && typeof o.value === "string",
      );
      if (!selectValueAccepted(optionsTyped, field.default)) {
        errors.push(
          `${path}.default "${field.default}" must be one of the option values`,
        );
      }
    }
  }
}

function validateTextField(
  path: string,
  field: Record<string, unknown>,
  errors: string[],
): void {
  if (field.default !== undefined && typeof field.default !== "string") {
    errors.push(`${path}.default must be a string`);
  }
  if (field.minLength !== undefined && !isNonNegativeInt(field.minLength)) {
    errors.push(`${path}.minLength must be a non-negative integer`);
  }
  if (field.maxLength !== undefined && !isNonNegativeInt(field.maxLength)) {
    errors.push(`${path}.maxLength must be a non-negative integer`);
  }
  const minOk = field.minLength === undefined || isNonNegativeInt(field.minLength);
  const maxOk = field.maxLength === undefined || isNonNegativeInt(field.maxLength);
  if (
    minOk &&
    maxOk &&
    field.minLength !== undefined &&
    field.maxLength !== undefined &&
    (field.minLength as number) > (field.maxLength as number)
  ) {
    errors.push(`${path}.minLength must be <= maxLength`);
  }
  let compiledPattern: RegExp | null = null;
  if (field.pattern !== undefined) {
    if (typeof field.pattern !== "string") {
      errors.push(`${path}.pattern must be a string`);
    } else {
      try {
        compiledPattern = new RegExp(field.pattern);
      } catch (e) {
        errors.push(
          `${path}.pattern is not a valid regex: ${(e as Error).message}`,
        );
      }
    }
  }
  if (typeof field.default === "string") {
    const d = field.default;
    const fieldNorm = {
      minLength: isNonNegativeInt(field.minLength) ? (field.minLength as number) : undefined,
      maxLength: isNonNegativeInt(field.maxLength) ? (field.maxLength as number) : undefined,
    };
    if (!textLengthMinOk(fieldNorm, d.length)) {
      errors.push(`${path}.default length must be >= minLength`);
    }
    if (!textLengthMaxOk(fieldNorm, d.length)) {
      errors.push(`${path}.default length must be <= maxLength`);
    }
    if (compiledPattern && !compiledPattern.test(d)) {
      errors.push(`${path}.default must match pattern`);
    }
  }
}

function validateNumberField(
  path: string,
  field: Record<string, unknown>,
  errors: string[],
): void {
  for (const key of ["default", "min", "max", "step"] as const) {
    if (field[key] !== undefined && !isFiniteNumber(field[key])) {
      errors.push(`${path}.${key} must be a finite number`);
    }
  }
  if (field.integer !== undefined && typeof field.integer !== "boolean") {
    errors.push(`${path}.integer must be a boolean`);
  }
  if (
    isFiniteNumber(field.min) &&
    isFiniteNumber(field.max) &&
    (field.min as number) > (field.max as number)
  ) {
    errors.push(`${path}.min must be <= max`);
  }
  if (isFiniteNumber(field.default)) {
    const d = field.default as number;
    const fieldNorm = {
      min: isFiniteNumber(field.min) ? (field.min as number) : undefined,
      max: isFiniteNumber(field.max) ? (field.max as number) : undefined,
      integer: field.integer === true ? true : undefined,
    };
    if (!numberMinOk(fieldNorm, d)) {
      errors.push(`${path}.default must be >= min`);
    }
    if (!numberMaxOk(fieldNorm, d)) {
      errors.push(`${path}.default must be <= max`);
    }
    if (!numberIntegerOk(fieldNorm, d)) {
      errors.push(`${path}.default must be an integer when integer is true`);
    }
  }
}

function validateBooleanField(
  path: string,
  field: Record<string, unknown>,
  errors: string[],
): void {
  if (field.default !== undefined && typeof field.default !== "boolean") {
    errors.push(`${path}.default must be a boolean`);
  }
}

export function validateSettingsSchema(
  settings: unknown,
  errors: string[],
): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    errors.push("settings must be a plain object");
    return;
  }
  for (const [key, raw] of Object.entries(settings as Record<string, unknown>)) {
    if (!SETTINGS_KEY_REGEX.test(key) || key.includes("..")) {
      errors.push(
        `settings key "${key}" must match /^[a-z][a-z0-9_]{0,63}$/ (filesystem-safe, no leading digit/underscore)`,
      );
      continue;
    }
    const path = `settings.${key}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const field = raw as Record<string, unknown>;
    if (typeof field.type !== "string" || !SETTINGS_FIELD_TYPES.has(field.type)) {
      errors.push(
        `${path}.type must be one of "select"|"text"|"number"|"boolean"`,
      );
      continue;
    }
    if (typeof field.label !== "string" || field.label.length === 0) {
      errors.push(`${path}.label is required and must be a non-empty string`);
    }
    if (field.description !== undefined && typeof field.description !== "string") {
      errors.push(`${path}.description must be a string`);
    }
    switch (field.type) {
      case "select":
        validateSelectField(path, field, errors);
        break;
      case "text":
        validateTextField(path, field, errors);
        break;
      case "number":
        validateNumberField(path, field, errors);
        break;
      case "boolean":
        validateBooleanField(path, field, errors);
        break;
    }
  }
}

function validatePermissionsBlock(perms: unknown, errors: string[]): void {
  if (!perms || typeof perms !== "object") return; // top-level guard handled elsewhere
  const p = perms as Record<string, unknown>;
  if (p.appendMessages !== undefined) {
    if (typeof p.appendMessages !== "object" || Array.isArray(p.appendMessages)) {
      errors.push("permissions.appendMessages must be an object");
    } else {
      const a = p.appendMessages as Record<string, unknown>;
      if (typeof a.excludedDefault !== "boolean") {
        errors.push(
          "permissions.appendMessages.excludedDefault must be a boolean",
        );
      }
    }
  }
}

// ── Main Validator ───────────────────────────────────────────────

export function validateManifestV2(
  data: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Manifest must be a non-null object"] };
  }

  const m = data as Record<string, unknown>;

  // Required fields
  if (m.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!m.name || typeof m.name !== "string") {
    errors.push("name is required and must be a non-empty string");
  } else if (!NAME_REGEX.test(m.name) || m.name.includes("..")) {
    errors.push(
      "name must match /^[a-z0-9][a-z0-9-_.]{0,63}$/ and must not contain '..' (filesystem-safe, no path separators)",
    );
  }
  if (
    typeof m.version !== "string" ||
    !SEMVER_REGEX.test(m.version)
  )
    errors.push("version must be valid semver (e.g., 1.0.0)");
  if (!m.description || typeof m.description !== "string")
    errors.push("description is required and must be a non-empty string");

  // Narrow `author` to its record form before reading `.name`. The outer
  // `typeof === "object"` guard already rules out null + primitives but
  // doesn't give TS access to a `name` field.
  const author = typeof m.author === "object" && m.author !== null
    ? (m.author as Record<string, unknown>)
    : null;
  if (!author?.name || typeof author.name !== "string")
    errors.push("author.name is required and must be a non-empty string");

  // Validate each component type if present
  if (m.tools !== undefined) validateToolsArray(m.tools, errors);
  if (m.skills !== undefined) validateSkillsArray(m.skills, errors);
  if (m.mcpServers !== undefined) validateMcpServersArray(m.mcpServers, errors);
  if (m.agent !== undefined) validateAgentComponent(m.agent, errors);
  if (m.scripts !== undefined) validateScriptsBlock(m.scripts, errors);
  if (m.permissions !== undefined)
    validatePermissionsBlock(m.permissions, errors);
  if (m.messageToolbar !== undefined) {
    const declaredEventSubs = Array.isArray(
      (m.permissions as Record<string, unknown>)?.eventSubscriptions,
    )
      ? ((m.permissions as Record<string, unknown>)
          .eventSubscriptions as string[])
      : [];
    validateMessageToolbarArray(
      typeof m.name === "string" ? m.name : "",
      m.messageToolbar,
      declaredEventSubs,
      errors,
    );
  }
  if (m.settings !== undefined) validateSettingsSchema(m.settings, errors);

  // Entrypoint required if tools are declared -- except for MCP-kind manifests,
  // whose tools[] is a cache of the remote server's tools/list.
  if (
    Array.isArray(m.tools) &&
    m.tools.length > 0 &&
    !m.entrypoint &&
    m.kind !== "mcp"
  )
    errors.push("entrypoint is required when tools are declared");

  // Entrypoint must stay inside the extension install directory: reject
  // absolute paths and any `..` traversal. The resolved import happens
  // relative to `<installPath>/`; without this, a malicious manifest
  // could point at `/etc/shadow` or `../../node_modules/...`.
  if (m.entrypoint !== undefined) {
    if (typeof m.entrypoint !== "string") {
      errors.push("entrypoint must be a string");
    } else {
      const ep = m.entrypoint;
      if (ep.startsWith("/"))
        errors.push("entrypoint must be a relative path, not absolute");
      else if (ep.split(/[\\/]/).includes(".."))
        errors.push("entrypoint must not contain '..' path segments");
    }
  }

  // Validate dependencies if present
  if (m.dependencies !== undefined) {
    const depResult = validateDependencies(m.dependencies);
    errors.push(...depResult.errors);
  }

  if (m.acceptedAttachmentMimes !== undefined) {
    if (!Array.isArray(m.acceptedAttachmentMimes)) {
      errors.push("acceptedAttachmentMimes must be an array of strings");
    } else {
      for (let i = 0; i < m.acceptedAttachmentMimes.length; i++) {
        const v = m.acceptedAttachmentMimes[i];
        if (typeof v !== "string" || !MIME_REGEX.test(v)) {
          errors.push(
            `acceptedAttachmentMimes[${i}] must be a valid MIME of the form "type/subtype" (RFC 6838 token chars, exactly one slash)`,
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Version Range Satisfaction ───────────────────────────────────

const CARET_REGEX = /^\^(\d+\.\d+\.\d+)$/;

/**
 * Check if `version` satisfies `range`.
 * Supports exact match ("1.2.3") and caret ("^1.2.3") only.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const caretMatch = CARET_REGEX.exec(range);
  if (!caretMatch) {
    // Exact match
    return version === range;
  }

  const floor = caretMatch[1]!;
  const [major, minor] = floor.split(".").map(Number) as [number, number];
  const [vMajor, vMinor] = version.split(".").map(Number) as [number, number];

  if (major === 0) {
    // ^0.x.y: same major and minor, patch >= floor patch
    return vMajor === 0 && vMinor === minor && compareVersions(version, floor) >= 0;
  }

  // ^X.Y.Z (X >= 1): same major, version >= floor
  return vMajor === major && compareVersions(version, floor) >= 0;
}

// ── Dependency Validation ───────────────────────────────────────

const VALID_VERSION_REGEX = /^(\^)?\d+\.\d+\.\d+$/;

export function validateDependencies(
  deps: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
    return { valid: false, errors: ["dependencies must be a plain object"] };
  }

  for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      errors.push(`dependencies.${name} must be an object with source and version`);
      continue;
    }

    const s = spec as Record<string, unknown>;

    if (!s.source || typeof s.source !== "string") {
      errors.push(`dependencies.${name}.source is required and must be a string`);
    }

    if (!s.version || typeof s.version !== "string") {
      errors.push(`dependencies.${name}.version is required and must be a string`);
    } else {
      const v = s.version as string;
      if (!VALID_VERSION_REGEX.test(v)) {
        errors.push(
          `dependencies.${name}.version "${v}" is invalid — only exact (1.0.0) or caret (^1.0.0) ranges are supported (no ~, *, >=)`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Utilities (moved from src/marketplace/manifest.ts) ───────────

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff < 0) return -1;
    if (diff > 0) return 1;
  }
  return 0;
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
