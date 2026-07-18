import { inferPackageType } from "./types";
import type {
  CapabilityDeclaration,
  ExtensionManifest,
  ExtensionManifestInternal,
  ExtensionPermissions,
  SettingsField,
  ToolDefinition,
} from "./types";
import { validateEntitiesArray } from "./entities/clamp";
import { parseSource } from "./source-parser";
// PURE import (no DB chain) — the scope-name grammar shared with the
// storage layer; see src/extensions/rbac-scopes.ts.
import { CORE_RBAC_SCOPES, validateRbacScopeDeclarations } from "./rbac-scopes";
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

// Preprocessor `accepts` entries additionally allow a type-level glob
// ("image/*"): a valid RFC 6838 type token followed by a literal "/*".
// Note the type token still can't start with "*" — a bare "*/*" is
// rejected (the spec's contract is exact MIME or `type/*`, nothing wider).
const MIME_GLOB_REGEX = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/\*$/;

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
    if (t.capabilities !== undefined) {
      validateToolCapabilities(`tools[${i}].capabilities`, t.capabilities, errors);
    }
    if (t.suggestExamples !== undefined) {
      validateSuggestExamples(`tools[${i}].suggestExamples`, t.suggestExamples, errors);
    }
  }
}

/**
 * Cross-field validation: a tool's optional `rbacScope` (the
 * user→extension gate the host enforces at dispatch) must name a
 * CHECKABLE scope — a core verb, or a custom scope this manifest declares
 * in `permissions.rbacScopes`. Mirrors the `ezcorp/rbac-check` allowlist
 * exactly so the host-enforced pre-dispatch gate can never key off a
 * scope no grant could ever hold (an authoring bug — rejected at admit
 * time instead of silently denying every non-admin caller at runtime).
 */
function validateToolRbacScopes(
  tools: unknown,
  permissions: unknown,
  errors: string[],
): void {
  if (!Array.isArray(tools)) return;
  const checkable = new Set<string>(CORE_RBAC_SCOPES);
  const declared = (permissions as { rbacScopes?: unknown } | null | undefined)
    ?.rbacScopes;
  if (Array.isArray(declared)) {
    for (const s of declared) {
      const name = (s as { name?: unknown })?.name;
      if (typeof name === "string") checkable.add(name);
    }
  }
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!t || typeof t !== "object") continue;
    const scope = (t as Record<string, unknown>).rbacScope;
    if (scope === undefined) continue;
    if (typeof scope !== "string" || scope.length === 0) {
      errors.push(`tools[${i}].rbacScope must be a non-empty string`);
      continue;
    }
    if (!checkable.has(scope)) {
      errors.push(
        `tools[${i}].rbacScope "${scope}" must be a core verb (${CORE_RBAC_SCOPES.join(", ")}) or a scope declared in permissions.rbacScopes`,
      );
    }
  }
}

/**
 * Phase 1 v3 per-tool `capabilities` block. Shape is `{network?,
 * filesystem?, shell?, env?, storage?, custom?}` — see
 * `CapabilityDeclaration` in `./types.ts`.
 */
function validateToolCapabilities(
  path: string,
  caps: unknown,
  errors: string[],
): void {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const c = caps as Record<string, unknown>;
  if (c.network !== undefined) {
    if (
      !c.network ||
      typeof c.network !== "object" ||
      Array.isArray(c.network) ||
      !Array.isArray((c.network as Record<string, unknown>).hosts)
    ) {
      errors.push(`${path}.network must be { hosts: string[] }`);
    } else {
      for (const h of (c.network as { hosts: unknown[] }).hosts) {
        if (typeof h !== "string") {
          errors.push(`${path}.network.hosts entries must be strings`);
          break;
        }
      }
    }
  }
  if (c.filesystem !== undefined) {
    if (
      !c.filesystem ||
      typeof c.filesystem !== "object" ||
      Array.isArray(c.filesystem) ||
      !Array.isArray((c.filesystem as Record<string, unknown>).paths) ||
      !Array.isArray((c.filesystem as Record<string, unknown>).mode)
    ) {
      errors.push(
        `${path}.filesystem must be { paths: string[], mode: ("read"|"write")[] }`,
      );
    } else {
      const fs = c.filesystem as { paths: unknown[]; mode: unknown[] };
      for (const p of fs.paths) {
        if (typeof p !== "string") {
          errors.push(`${path}.filesystem.paths entries must be strings`);
          break;
        }
      }
      for (const m of fs.mode) {
        if (m !== "read" && m !== "write") {
          errors.push(`${path}.filesystem.mode entries must be "read" or "write"`);
          break;
        }
      }
    }
  }
  if (c.shell !== undefined && typeof c.shell !== "boolean") {
    errors.push(`${path}.shell must be a boolean`);
  }
  if (c.env !== undefined) {
    if (!Array.isArray(c.env)) {
      errors.push(`${path}.env must be a string array`);
    } else {
      for (const e of c.env as unknown[]) {
        if (typeof e !== "string") {
          errors.push(`${path}.env entries must be strings`);
          break;
        }
      }
    }
  }
  if (c.storage !== undefined && typeof c.storage !== "boolean") {
    errors.push(`${path}.storage must be a boolean`);
  }
  if (c.custom !== undefined) {
    if (!c.custom || typeof c.custom !== "object" || Array.isArray(c.custom)) {
      errors.push(`${path}.custom must be a plain object`);
    } else {
      for (const [k, v] of Object.entries(c.custom)) {
        if (typeof v !== "boolean" && !Array.isArray(v)) {
          errors.push(`${path}.custom.${k} must be a boolean or string array`);
        }
      }
    }
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

// ── Hub pages (Extension Pages Hub) ───────────────────────────────
//
// Mirrors `validateMessageToolbarArray`'s shape rules: slug ids with
// dedupe, hard caps on the user-visible strings, and a small max count
// (a tab strip with more than 3 tabs per extension is a UX smell, and
// the cap bounds Hub list fan-out).

const PAGE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PAGES = 3;
const MAX_PAGE_TITLE = 50;
const MAX_PAGE_DESCRIPTION = 200;

export function validatePagesArray(items: unknown, errors: string[]): void {
  if (!Array.isArray(items)) {
    errors.push("pages must be an array");
    return;
  }
  if (items.length > MAX_PAGES) {
    errors.push(`pages must declare at most ${MAX_PAGES} entries`);
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Record<string, unknown>;
    if (!it || typeof it !== "object") {
      errors.push(`pages[${i}] must be an object`);
      continue;
    }
    if (typeof it.id !== "string" || !PAGE_ID_REGEX.test(it.id)) {
      errors.push(`pages[${i}].id must match /^[a-z0-9][a-z0-9-]{0,31}$/`);
    } else if (seenIds.has(it.id)) {
      errors.push(`pages[${i}].id "${it.id}" is duplicated`);
    } else {
      seenIds.add(it.id);
    }
    if (!it.title || typeof it.title !== "string") {
      errors.push(`pages[${i}].title is required and must be a string`);
    } else if (it.title.length > MAX_PAGE_TITLE) {
      errors.push(`pages[${i}].title must be at most ${MAX_PAGE_TITLE} characters`);
    }
    if (it.icon !== undefined && typeof it.icon !== "string") {
      errors.push(`pages[${i}].icon must be a string`);
    }
    if (it.description !== undefined) {
      if (typeof it.description !== "string") {
        errors.push(`pages[${i}].description must be a string`);
      } else if (it.description.length > MAX_PAGE_DESCRIPTION) {
        errors.push(
          `pages[${i}].description must be at most ${MAX_PAGE_DESCRIPTION} characters`,
        );
      }
    }
    // Per-project toggle: the page renders with project context on
    // `/project/<id>/hub/...` and with the full project list on the
    // global hub (see web/src/lib/server/hub-render-pull.ts).
    if (it.perProject !== undefined && typeof it.perProject !== "boolean") {
      errors.push(`pages[${i}].perProject must be a boolean`);
    }
  }
}

// Settings keys are used as filesystem-safe identifiers and as JS-object
// keys exposed to extension authors — keep them lowercase, no traversal,
// no leading digit/underscore.
const SETTINGS_KEY_REGEX = /^[a-z][a-z0-9_]{0,63}$/;
const SETTINGS_FIELD_TYPES = new Set(["select", "text", "number", "boolean", "secret"]);

// Secret fields write into extension storage — the storageKey must satisfy
// the storage layer's own key rules (see storage-handler's KEY_REGEX) while
// staying conservative: lowercase alnum start, then alnum/underscore/dot/dash,
// ≤ 64 chars total, and NO trailing dot — storage-handler's validateKey
// rejects keys ending in "." on read, so admitting one here would create a
// storageKey the extension could never read back. e.g. the
// graded-card-scanner's "psa-token".
const SECRET_STORAGE_KEY_REGEX = /^(?!.*\.$)[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Max plaintext length accepted for a secret settings value (chars). */
export const SECRET_SETTING_MAX_LENGTH = 512;

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
        if (!re?.test(value)) return false;
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
    case "secret":
      // Write-path validity only: the PUT route uses this to accept a new
      // plaintext value before encrypting it into extension storage. The
      // value itself is NEVER persisted in the settings JSON blob —
      // `clampSettings` drops secret fields unconditionally.
      return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= SECRET_SETTING_MAX_LENGTH
      );
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

function validateSecretField(
  path: string,
  field: Record<string, unknown>,
  errors: string[],
): void {
  if (
    typeof field.storageKey !== "string" ||
    !SECRET_STORAGE_KEY_REGEX.test(field.storageKey)
  ) {
    errors.push(
      `${path}.storageKey is required on secret fields and must match /^[a-z0-9][a-z0-9_.-]{0,63}$/ with no trailing dot`,
    );
  }
  // Secrets are write-only: a declared default would be a plaintext
  // credential in the manifest — reject at admit time.
  if (field.default !== undefined) {
    errors.push(`${path}.default is not allowed on secret fields`);
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
        `${path}.type must be one of "select"|"text"|"number"|"boolean"|"secret"`,
      );
      continue;
    }
    if (typeof field.label !== "string" || field.label.length === 0) {
      errors.push(`${path}.label is required and must be a non-empty string`);
    }
    if (field.description !== undefined && typeof field.description !== "string") {
      errors.push(`${path}.description must be a string`);
    }
    // storageKey is the secret-field storage target — meaningless (and a
    // likely authoring bug) on any other type, so reject it there.
    if (field.type !== "secret" && field.storageKey !== undefined) {
      errors.push(`${path}.storageKey is only allowed on secret fields`);
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
      case "secret":
        validateSecretField(path, field, errors);
        break;
    }
  }
}

// WS3 quality-tier routing. An extension may declare the model tier its
// work needs; the tier classifier reads it when the conversation has no
// established model. Reject-at-admit — a bad declaration is an authoring
// bug, not something to silently drop.
const ROUTING_TIERS = new Set(["fast", "balanced", "powerful"]);

export function validateRoutingBlock(routing: unknown, errors: string[]): void {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    errors.push("routing must be an object");
    return;
  }
  const tier = (routing as Record<string, unknown>).tier;
  if (typeof tier !== "string" || !ROUTING_TIERS.has(tier)) {
    errors.push(`routing.tier must be one of "fast"|"balanced"|"powerful"`);
  }
}

/** Structural check for the string-array permission fields (`network`,
 *  `env`, `filesystem`, and the array form of `eventSubscriptions`):
 *  must be an array whose every element is a non-empty string. An EMPTY
 *  array is valid — several manifests declare `eventSubscriptions: []`
 *  as an explicit "none" (the per-element rule is what's enforced). */
/** Webhook slug grammar (Loops EZ Mode Phase 4). A slug is interpolated into
 *  the public route path `/api/hooks/:extensionId/:slug`, so it is restricted
 *  to lowercase alphanumerics + hyphens, must start with an alphanumeric, and
 *  is ≤64 chars. Shared by manifest validation, the install reconciler, and the
 *  route so all three agree on what a legal slug is (no `.`/`/`/`%`/whitespace →
 *  no path traversal or route confusion). */
export const WEBHOOK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validateStringArrayPerm(
  field: string,
  value: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`permissions.${field} must be an array of non-empty strings`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`permissions.${field}[${i}] must be a non-empty string`);
    }
  }
}

function validatePermissionsBlock(perms: unknown, errors: string[]): void {
  if (!perms || typeof perms !== "object") return; // top-level guard handled elsewhere
  const p = perms as Record<string, unknown>;
  // Custom RBAC scope DECLARATIONS (inert — see src/extensions/rbac-scopes.ts
  // for the grammar / core-verb-collision / cap rules and the "declarations,
  // not privileges" contract). Reject-at-admit-time: a bad declaration is an
  // authoring bug, so there is no clamp-to-subset fallback.
  if (p.rbacScopes !== undefined) {
    validateRbacScopeDeclarations(p.rbacScopes, errors);
  }
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

  // ── Structural validation for the core fields (fix-wave B Phase 4) ──
  //
  // Reject-at-admit-time: a `network: "api.example.com"` (string, not
  // array) or a `shell: "yes"` used to sail through validation and only
  // misbehave deep in the clamp / spawn plumbing. Each rule below is the
  // field's ACTUAL type per `ExtensionManifestV2["permissions"]` — NOT a
  // tightening: every bundled + example manifest validates unchanged
  // (asserted by bundled-manifests-installable + the examples suites).

  // Arrays of non-empty strings.
  if (p.network !== undefined) validateStringArrayPerm("network", p.network, errors);
  if (p.env !== undefined) validateStringArrayPerm("env", p.env, errors);
  if (p.filesystem !== undefined) validateStringArrayPerm("filesystem", p.filesystem, errors);

  // eventSubscriptions: string[] OR the Phase 51.4 object form
  // `{events: string[], includeFullPayload?: boolean}`.
  if (p.eventSubscriptions !== undefined) {
    if (Array.isArray(p.eventSubscriptions)) {
      validateStringArrayPerm("eventSubscriptions", p.eventSubscriptions, errors);
    } else if (p.eventSubscriptions && typeof p.eventSubscriptions === "object") {
      const es = p.eventSubscriptions as Record<string, unknown>;
      validateStringArrayPerm("eventSubscriptions.events", es.events, errors);
      if (es.includeFullPayload !== undefined && typeof es.includeFullPayload !== "boolean") {
        errors.push("permissions.eventSubscriptions.includeFullPayload must be a boolean");
      }
    } else {
      errors.push(
        "permissions.eventSubscriptions must be an array of event names or {events, includeFullPayload?}",
      );
    }
  }

  // webhooks (Loops EZ Mode Phase 4): array of slug strings. Each slug is
  // interpolated into the public route path `/api/hooks/:extensionId/:slug`,
  // so it MUST be URL-path-safe — lowercase alphanumeric + hyphen, starting
  // with an alphanumeric, ≤64 chars. Rejecting `.`/`/`/`%`/whitespace here
  // closes off path-traversal and route-confusion at the manifest boundary
  // (defense in depth — the route also 404s an unmatched slug).
  if (p.webhooks !== undefined) {
    if (!Array.isArray(p.webhooks)) {
      errors.push("permissions.webhooks must be an array of hook slug strings");
    } else {
      for (let i = 0; i < p.webhooks.length; i++) {
        const s = p.webhooks[i];
        if (typeof s !== "string" || !WEBHOOK_SLUG_RE.test(s)) {
          errors.push(
            `permissions.webhooks[${i}] must be a slug matching ${WEBHOOK_SLUG_RE.source}`,
          );
        }
      }
    }
  }

  // Booleans where declared.
  for (const field of ["shell", "storage", "taskEvents", "loopEvents"] as const) {
    if (p[field] !== undefined && typeof p[field] !== "boolean") {
      errors.push(`permissions.${field} must be a boolean`);
    }
  }

  // spawnAgents: structured — {maxPerHour: positive number,
  // maxConcurrent?: positive number} (the type's shape; the clamp's
  // numeric ceilings assume real numbers here).
  if (p.spawnAgents !== undefined) {
    if (!p.spawnAgents || typeof p.spawnAgents !== "object" || Array.isArray(p.spawnAgents)) {
      errors.push("permissions.spawnAgents must be an object {maxPerHour, maxConcurrent?}");
    } else {
      const sa = p.spawnAgents as Record<string, unknown>;
      if (typeof sa.maxPerHour !== "number" || !Number.isFinite(sa.maxPerHour) || sa.maxPerHour <= 0) {
        errors.push("permissions.spawnAgents.maxPerHour must be a positive number");
      }
      if (
        sa.maxConcurrent !== undefined &&
        (typeof sa.maxConcurrent !== "number" || !Number.isFinite(sa.maxConcurrent) || sa.maxConcurrent <= 0)
      ) {
        errors.push("permissions.spawnAgents.maxConcurrent must be a positive number");
      }
    }
  }

  // agentConfig: "read" is the only value today (the type leaves room
  // for a future "write" tier — widen HERE when that lands).
  if (p.agentConfig !== undefined && p.agentConfig !== "read") {
    errors.push(`permissions.agentConfig must be "read"`);
  }
}

// ── Preprocessors Validator ──────────────────────────────────────

/**
 * Validate the optional top-level `preprocessors` array (deterministic
 * attachment pre-processing — see `PreprocessorDecl` in ./types.ts).
 * Applies to BOTH schemaVersion 2 and 3 manifests: `validateManifestV2`
 * accepts both versions, and `migrateManifestV2ToV3` passes the field
 * through untouched (asserted by preprocess-manifest-validation.test.ts).
 *
 * Rules (spec-locked):
 *   - `tool` MUST name a tool declared in this manifest's `tools[]` — a
 *     preprocessor pointing at a tool the extension doesn't export could
 *     never run, so it's an authoring bug rejected at admit time (mirrors
 *     `validateSmokeTest`'s cross-check).
 *   - `accepts` is a non-empty array of exact MIME strings ("image/png")
 *     or type-level globs ("image/*").
 */
export function validatePreprocessorsArray(
  preprocessors: unknown,
  declaredToolNames: string[],
  errors: string[],
): void {
  if (!Array.isArray(preprocessors)) {
    errors.push("preprocessors must be an array");
    return;
  }
  for (let i = 0; i < preprocessors.length; i++) {
    const p = preprocessors[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      errors.push(`preprocessors[${i}] must be an object`);
      continue;
    }
    if (typeof p.tool !== "string" || p.tool.length === 0) {
      errors.push(
        `preprocessors[${i}].tool is required and must be a non-empty string`,
      );
    } else if (!declaredToolNames.includes(p.tool)) {
      // Hoisted out of the template literal: mid-template continuation
      // lines lose DA attribution under bun's sharded coverage (same
      // jitter class as the preprocess-shared split) — plain statement
      // lines keep the patch-coverage gate honest.
      const declared = declaredToolNames.length > 0 ? declaredToolNames.join(", ") : "<none>";
      errors.push(
        `preprocessors[${i}].tool "${p.tool}" is not a declared tool (declared: ${declared})`,
      );
    }
    if (!Array.isArray(p.accepts) || p.accepts.length === 0) {
      errors.push(
        `preprocessors[${i}].accepts must be a non-empty array of MIME types`,
      );
    } else {
      for (let j = 0; j < p.accepts.length; j++) {
        const a = p.accepts[j];
        if (
          typeof a !== "string" ||
          !(MIME_REGEX.test(a) || MIME_GLOB_REGEX.test(a))
        ) {
          errors.push(
            `preprocessors[${i}].accepts[${j}] must be an exact MIME ("type/subtype") or a type glob ("type/*")`,
          );
        }
      }
    }
    if (p.description !== undefined && typeof p.description !== "string") {
      errors.push(`preprocessors[${i}].description must be a string`);
    }
  }
}

// ── npmDependencies Validator ────────────────────────────────────

// npm package-name grammar (npm's own validate-npm-package-name rules,
// reduced to the shape a registry name can take): optional `@scope/`
// prefix, then a name segment. Both segments start with an unreserved
// char and allow `[a-z0-9-._~]`. Length ≤ 214 (npm's hard cap).
const NPM_PKG_NAME_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_PKG_NAME_MAX_LENGTH = 214;

/**
 * Validate the optional top-level `npmDependencies` map (npm registry
 * package name → semver RANGE). Hand-rolled error-array style like the
 * other validators (NOT zod). Distinct from ext-to-ext `dependencies`:
 * these are ordinary npm modules the host VERIFIES at runtime (see
 * ./npm-deps.ts) — it does NOT install or clone them. No schemaVersion
 * bump: the field is optional on both v2 and v3, and
 * `migrateManifestV2ToV3` spreads it through untouched.
 *
 * Rules: a plain (non-array) object; each KEY is a valid npm package name
 * (≤ 214 chars); each VALUE is a non-empty string (the semver range —
 * the range grammar itself is validated at resolve time by
 * `Bun.semver.satisfies`, not here).
 */
export function validateNpmDependenciesBlock(
  value: unknown,
  errors: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("npmDependencies must be a plain object");
    return;
  }
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (name.length > NPM_PKG_NAME_MAX_LENGTH || !NPM_PKG_NAME_REGEX.test(name)) {
      errors.push(
        `npmDependencies key "${name}" must be a valid npm package name (≤ 214 chars, /^(@scope\\/)?name$/)`,
      );
    }
    if (typeof range !== "string" || range.length === 0) {
      errors.push(
        `npmDependencies.${name} must be a non-empty version-range string`,
      );
    }
  }
}

// ── suggestExamples Validator ────────────────────────────────────
//
// Composer-suggestion example phrasings — declared per-tool
// (`tools[i].suggestExamples`) and/or top-level (`suggestExamples`); both
// share this validator. The caps keep an author from stuffing the ranker:
// at most 5 short entries, each non-empty and ≤ 120 chars after trimming,
// with no duplicates once trimmed. These strings NEVER reach the LLM (they
// are stripped before the tool spec is built) — they only feed composer
// retrieval + the offline training export. No schemaVersion bump: the field
// is optional on both v2 and v3 (npmDependencies/PR #81 blueprint).

/** Max authored example phrasings per tool / per extension. */
export const MAX_SUGGEST_EXAMPLES = 5;
/** Max length (chars, after trimming) of a single example phrasing. */
export const MAX_SUGGEST_EXAMPLE_LENGTH = 120;

export function validateSuggestExamples(
  path: string,
  value: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return;
  }
  if (value.length > MAX_SUGGEST_EXAMPLES) {
    errors.push(`${path} must declare at most ${MAX_SUGGEST_EXAMPLES} entries`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (typeof raw !== "string") {
      errors.push(`${path}[${i}] must be a string`);
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      errors.push(`${path}[${i}] must be a non-empty string`);
      continue;
    }
    if (trimmed.length > MAX_SUGGEST_EXAMPLE_LENGTH) {
      errors.push(
        `${path}[${i}] must be at most ${MAX_SUGGEST_EXAMPLE_LENGTH} characters`,
      );
      continue;
    }
    // Control characters (incl. NUL) are rejected so an authored example can
    // never collide with the embedding cache's NUL-delimited tool keys —
    // examples are plain user phrasings and have no business carrying them.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point of this check
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      errors.push(`${path}[${i}] must not contain control characters`);
      continue;
    }
    if (seen.has(trimmed)) {
      errors.push(`${path}[${i}] "${trimmed}" is a duplicate`);
    } else {
      seen.add(trimmed);
    }
  }
}

// ── smokeTest Validator ──────────────────────────────────────────

/**
 * Validate the optional `smokeTest` block. Only invoked when present
 * (the field is OPTIONAL in `validateManifestV2` — the author path is
 * what makes it REQUIRED for tool/multi). Hand-rolled error-array
 * style, matching the rest of this validator (NOT zod).
 *
 * Cross-checks `smokeTest.tool` against the manifest's declared tool
 * names — a smoke test that targets a tool the extension doesn't export
 * can never produce a meaningful PASS.
 */
export function validateSmokeTest(
  smokeTest: unknown,
  declaredToolNames: string[],
  errors: string[],
): void {
  if (
    !smokeTest ||
    typeof smokeTest !== "object" ||
    Array.isArray(smokeTest)
  ) {
    errors.push("smokeTest must be an object");
    return;
  }
  const st = smokeTest as Record<string, unknown>;

  if (typeof st.tool !== "string" || st.tool.length === 0) {
    errors.push("smokeTest.tool is required and must be a non-empty string");
  } else if (!declaredToolNames.includes(st.tool)) {
    errors.push(
      `smokeTest.tool "${st.tool}" is not a declared tool (declared: ${
        declaredToolNames.length > 0 ? declaredToolNames.join(", ") : "<none>"
      })`,
    );
  }

  if (
    !st.input ||
    typeof st.input !== "object" ||
    Array.isArray(st.input)
  ) {
    errors.push("smokeTest.input is required and must be an object");
  }

  if (
    !st.expect ||
    typeof st.expect !== "object" ||
    Array.isArray(st.expect)
  ) {
    errors.push("smokeTest.expect is required and must be an object");
  } else {
    const ex = st.expect as Record<string, unknown>;
    if (ex.isError !== undefined && typeof ex.isError !== "boolean") {
      errors.push("smokeTest.expect.isError must be a boolean when set");
    }
    if (ex.textIncludes !== undefined && typeof ex.textIncludes !== "string") {
      errors.push("smokeTest.expect.textIncludes must be a string when set");
    }
    if (ex.isError === undefined && ex.textIncludes === undefined) {
      errors.push(
        "smokeTest.expect must declare at least one of `isError` or `textIncludes`",
      );
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
  if (m.schemaVersion !== 2 && m.schemaVersion !== 3) {
    errors.push(`schemaVersion must be 2 or 3, got ${String(m.schemaVersion)}`);
  }
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
  if (m.tools !== undefined) {
    validateToolsArray(m.tools, errors);
    // Cross-field: per-tool `rbacScope` must reference a checkable scope
    // (core verb or a `permissions.rbacScopes` declaration).
    validateToolRbacScopes(m.tools, m.permissions, errors);
  }
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
  if (m.pages !== undefined) validatePagesArray(m.pages, errors);
  if (m.routing !== undefined) validateRoutingBlock(m.routing, errors);
  if (m.settings !== undefined) validateSettingsSchema(m.settings, errors);
  if (m.entities !== undefined) validateEntitiesArray(m, m.entities, errors);

  // Declared tool names — shared cross-check input for the smokeTest and
  // preprocessors validators below (both must reference a tool this
  // manifest actually exports).
  const declaredToolNames = Array.isArray(m.tools)
    ? (m.tools as Array<Record<string, unknown>>)
        .map((t) => (typeof t?.name === "string" ? t.name : ""))
        .filter((n) => n.length > 0)
    : [];

  // Optional deterministic acceptance smoke test. Only checked when
  // present — kept OPTIONAL here so the existing bundled corpus stays
  // valid; the author path enforces presence for tool/multi.
  if (m.smokeTest !== undefined) {
    validateSmokeTest(m.smokeTest, declaredToolNames, errors);
  }

  // Optional deterministic attachment preprocessors (schemaVersion 2 AND
  // 3 — this validator gates both). See validatePreprocessorsArray.
  if (m.preprocessors !== undefined) {
    validatePreprocessorsArray(m.preprocessors, declaredToolNames, errors);
  }

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

  // Optional third-party npm dependency contract (verify-only, v1).
  // Distinct from the ext-to-ext `dependencies` block above.
  if (m.npmDependencies !== undefined) {
    validateNpmDependenciesBlock(m.npmDependencies, errors);
  }

  // Optional top-level composer-suggestion example phrasings (whole-extension
  // intent). Per-tool examples are validated inside validateToolsArray.
  if (m.suggestExamples !== undefined) {
    validateSuggestExamples("suggestExamples", m.suggestExamples, errors);
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

  // Phase 4 deputy / orchestration opt-in flags. Both are optional and
  // boolean. The runtime check is `=== true`; v2 manifests omitting
  // them inherit the default opted-out behavior.
  if (m.acceptsCallerCaps !== undefined && typeof m.acceptsCallerCaps !== "boolean") {
    errors.push("acceptsCallerCaps must be a boolean when set");
  }
  if (m.escalateChildCaps !== undefined && typeof m.escalateChildCaps !== "boolean") {
    errors.push("escalateChildCaps must be a boolean when set");
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
    } else {
      // Dependency sources drive `git clone` directly (and dependencies
      // inherit the root install's permission grants), so reject anything
      // the source parser wouldn't accept — including option-shaped or
      // metacharacter-laden refs — at manifest-validation time.
      try {
        parseSource(s.source);
      } catch (err) {
        errors.push(
          `dependencies.${name}.source is invalid: ${(err as Error).message}`,
        );
      }
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

// ── V2 → V3 Manifest Migration ──────────────────────────────────────
//
// Phase 1: every downstream consumer (registry, tool-executor, PDP)
// works with v3 shape. The loader runs `migrateManifestV2ToV3` after
// validation so authors can keep writing v2 manifests while the
// runtime sees per-tool capability declarations.
//
// Migration rule: each tool inherits the extension-wide ceiling
// (`m.permissions` translated to `CapabilityDeclaration`). Tools that
// already declared their own `capabilities` keep their authored
// declaration — the migration NEVER widens an authored cap set.

/**
 * Promote a v2 manifest to v3-shape with per-tool capability
 * declarations. v3 manifests pass through with `_inheritedFromV2`
 * unset.
 */
export function migrateManifestV2ToV3(
  m: ExtensionManifest,
): ExtensionManifestInternal {
  if (m.schemaVersion === 3) return m as ExtensionManifestInternal;

  const inherited = deriveCapsFromExtensionPerms(m.permissions);

  // Distribute the inherited cap set to every tool that lacks an
  // authored declaration. Authored declarations are preserved exactly
  // — no widening.
  const tools: ToolDefinition[] = (m.tools ?? []).map((t) => ({
    ...t,
    capabilities: t.capabilities ?? inherited,
  }));

  return {
    ...m,
    schemaVersion: 3,
    tools,
    _inheritedFromV2: true,
  };
}

/**
 * Translate the extension-wide `permissions` block into a
 * `CapabilityDeclaration`. Used by `migrateManifestV2ToV3` and made
 * available for tooling that needs the same translation
 * (e.g. install-time UI rendering).
 */
export function deriveCapsFromExtensionPerms(
  perms: ExtensionPermissions | ExtensionManifest["permissions"] | undefined,
): CapabilityDeclaration {
  const decl: CapabilityDeclaration = {};
  if (!perms) return decl;

  if (perms.network && perms.network.length > 0) {
    decl.network = { hosts: [...perms.network] };
  }
  if (perms.filesystem && perms.filesystem.length > 0) {
    // V2 filesystem was a flat allowlist with implicit read+write —
    // mirror that semantics in v3 by declaring both modes.
    decl.filesystem = {
      paths: [...perms.filesystem],
      mode: ["read", "write"],
    };
  }
  if (perms.shell === true) {
    decl.shell = true;
  }
  if (perms.env && perms.env.length > 0) {
    decl.env = [...perms.env];
  }
  if (perms.storage === true) {
    decl.storage = true;
  }

  // Phase 6 — namespace migration. Translate the legacy boolean fields
  // to their `ezcorp:*` namespaced form via NAMESPACE_MAP. The runtime
  // (`capabilityDeclarationToSet` in capability-types.ts) accepts BOTH
  // the legacy keys and the namespaced keys for back-compat: extension
  // manifests can declare either name. Internally, the PDP and audit
  // rows use the namespaced form.
  const custom: Record<string, string[] | boolean> = {};
  if (perms.appendMessages !== undefined) {
    custom[NAMESPACE_MAP.appendMessages] = true;
  }
  if (perms.agentConfig === "read") {
    custom[NAMESPACE_MAP.agentConfig] = true;
  }
  if (perms.spawnAgents) {
    custom[NAMESPACE_MAP.spawnAgents] = true;
  }
  if (perms.taskEvents === true) {
    custom[NAMESPACE_MAP.taskEvents] = true;
  }
  if (perms.loopEvents === true) {
    custom[NAMESPACE_MAP.loopEvents] = true;
  }
  // eventSubscriptions accepts both the legacy string[] form and the
  // Phase 51.4 `{events, includeFullPayload?}` object form. Normalize
  // to a string[] before propagating to the namespaced cap declaration.
  const subs = perms.eventSubscriptions;
  const subsList = Array.isArray(subs) ? subs : subs?.events;
  if (subsList && subsList.length > 0) {
    custom[NAMESPACE_MAP.eventSubscriptions] = [...subsList];
  }
  if (perms.webhooks && perms.webhooks.length > 0) {
    custom[NAMESPACE_MAP.webhooks] = [...perms.webhooks];
  }
  if (Object.keys(custom).length > 0) {
    decl.custom = custom;
  }

  return decl;
}

/**
 * Phase 6 — capability namespace migration map. Translates the legacy
 * boolean / object-shaped permission keys (`appendMessages`,
 * `agentConfig`, `taskEvents`, `spawnAgents`, `eventSubscriptions`) to
 * their `ezcorp:*` namespaced form. The runtime continues to read both
 * old + new names for back-compat (extension manifests can declare
 * either); internally the PDP and audit rows use the namespaced form.
 *
 * `migrateManifestV2ToV3` and `deriveCapsFromExtensionPerms` both
 * consume this map so the translation is anchored in exactly one place.
 */
export const NAMESPACE_MAP = {
  appendMessages: "ezcorp:chat:append",
  agentConfig: "ezcorp:agent:config",
  taskEvents: "ezcorp:tasks:emit",
  loopEvents: "ezcorp:loops:emit",
  spawnAgents: "ezcorp:agent:spawn",
  eventSubscriptions: "ezcorp:events:subscribe",
  webhooks: "ezcorp:webhooks:receive",
} as const;
