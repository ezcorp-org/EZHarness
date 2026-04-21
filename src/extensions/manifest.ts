import { inferPackageType } from "./types";
export { inferPackageType };

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

// Manifest name constraints: must be filesystem-safe so the installer can use
// it as a directory name under data/extensions/<name> without any caller
// needing to sanitize. Rejects path separators (`/`, `\`), traversal (`..`),
// leading dots, and length > 64.
const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

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

  if (
    !m.author ||
    typeof m.author !== "object" ||
    !(m.author as any).name ||
    typeof (m.author as any).name !== "string"
  )
    errors.push("author.name is required and must be a non-empty string");

  // Validate each component type if present
  if (m.tools !== undefined) validateToolsArray(m.tools, errors);
  if (m.skills !== undefined) validateSkillsArray(m.skills, errors);
  if (m.mcpServers !== undefined) validateMcpServersArray(m.mcpServers, errors);
  if (m.agent !== undefined) validateAgentComponent(m.agent, errors);
  if (m.scripts !== undefined) validateScriptsBlock(m.scripts, errors);

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
