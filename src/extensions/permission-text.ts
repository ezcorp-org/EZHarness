/**
 * Readable permission lines: the one source of the text the CLI, the install
 * prompt and the extension author page's approval card show. Pure (no node
 * builtins, no database), so the browser can import it too.
 */
import type { ExtensionManifest } from "./types";
import type { ExtensionManifestV4, ProcessSpawnPolicy } from "@ezcorp/extension-contract";
// The pure subpath: the package root loads the validators, which compile
// schemas with `new Function` and break a page under its CSP.
import { declaresStdioMcpServer } from "@ezcorp/extension-contract/spawn-policy";

export interface PermissionItem {
  type: string;
  value: string | boolean;
  description: string;
}

/** Every permission a manifest can declare: the host's v2 view and the v4 contract. */
type ManifestPermissions = ExtensionManifest["permissions"] & ExtensionManifestV4["permissions"];
type PermissionName = keyof ManifestPermissions;
type Line = Pick<PermissionItem, "value" | "description">;
/** "generic" prints `name: value`, for a permission with no specific text yet. */
type Describe<K extends PermissionName> = ((value: NonNullable<ManifestPermissions[K]>) => Line[]) | "generic";

const one = (description: string): Line[] => [{ value: true, description }];
const each = (values: readonly string[], format: (value: string) => string): Line[] => values.map((value) => ({ value, description: format(value) }));
const access = (level: "read" | "write") => (level === "write" ? "Read and write" : "Read");
const limits = (parts: (string | false)[]) => { const kept = parts.filter(Boolean); return kept.length ? ` (${kept.join(", ")})` : ""; };

const SHELL_TEXT = "Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)";

/**
 * One entry per permission type, in display order. The mapped type makes a
 * new permission in the manifest type a compile error here, and
 * permission-text.test.ts checks the same with the TypeScript checker.
 */
const DESCRIBE: { [K in PermissionName]-?: Describe<K> } = {
  network: (v) => each(v, (domain) => `Network access to ${domain}`),
  filesystem: (v) => each(v, (path) => `Filesystem access to ${path}`),
  shell: (v) => (v ? one(SHELL_TEXT) : []),
  env: (v) => each(v, (name) => `Read environment variable ${name}`),
  storage: (v) => (v ? one("Persistent key-value storage") : []),
  networkTcp: (v) => each(v, (destination) => `Opaque TCP connection to ${destination}`),
  secretRead: (v) => each(v, (provider) => `Read the raw credential for ${provider}`),
  hostApi: (v) => [...v.routes.map((route) => ({ value: `${route.method} ${route.path}`, description: `Call the host API ${route.method} ${route.path}` })), ...(v.events ? one("Receive host API events") : [])],
  lifecycleHooks: (v) => (v ? one("Run install and uninstall hooks") : []),
  taskEvents: (v) => (v ? one("Post task-panel updates in the conversation that calls it") : []),
  loopEvents: (v) => (v ? one("Send approval notices for its own loops") : []),
  spawnAgents: (v) => one(`Start sub-agent runs${limits([`at most ${v.maxPerHour} per hour`, v.maxConcurrent !== undefined && `${v.maxConcurrent} at a time`])}`),
  agentConfig: () => one("Read your agent configurations"),
  eventSubscriptions: (v) => {
    const events = Array.isArray(v) ? v : v.events;
    const full = !Array.isArray(v) && v.includeFullPayload ? " (with full tool input and output)" : "";
    return events.length ? one(`Receive these app events: ${events.join(", ")}${full}`) : [];
  },
  webhooks: (v) => each(v, (slug) => `Receive webhook deliveries on ${slug}`),
  triggers: (v) => one(`Create its own cron and webhook triggers${limits([v.maxCron !== undefined && `cron limit ${v.maxCron}`, v.maxWebhooks !== undefined && `webhook limit ${v.maxWebhooks}`, v.maxRunsPerDay !== undefined && `${v.maxRunsPerDay} runs per day`])}`),
  workflows: (v) => one(`Run the workflows ${v.names.join(", ")}${limits([v.maxRunsPerHour !== undefined && `at most ${v.maxRunsPerHour} per hour`])}`),
  appendMessages: () => one("Add messages to the conversation"),
  llm: (v) => one(`Call language models from ${v.providers.join(", ")}${limits([v.maxCallsPerHour !== undefined && `at most ${v.maxCallsPerHour} calls per hour`, v.maxCallsPerDay !== undefined && `${v.maxCallsPerDay} per day`])}`),
  memory: (v) => one(`${access(v.access)} your memories`),
  lessons: (v) => one(`${access(v.access)} lessons`),
  schedule: (v) => each(v.crons, (cron) => `Run on a schedule: ${cron}`),
  search: (v) => (v === false ? [] : one("Run web searches")),
  mcpInvoke: (v) => (v ? one("Call the tools of its MCP server") : []),
  rbacScopes: "generic",
  custom: "generic",
};

/** The permission types this module describes (tested against the manifest type). */
export const DESCRIBED_PERMISSIONS: readonly string[] = Object.keys(DESCRIBE);

const MCP_TEXT = {
  // The manifest alone cannot say whether the server may start: that is the
  // host's spawn policy (process-spawn-policy.ts), so the default is neutral.
  neutral: "Has a stdio MCP server: it can start its server only if the release is a plain MCP bridge or has the shell permission",
  allow: "Starts its MCP server process (process spawning allowed)",
  deny: "Cannot start its MCP server process: starting processes needs the shell permission",
};

function describePermission(name: string, value: unknown): Line[] {
  const describe = (DESCRIBE as Record<string, Describe<PermissionName> | undefined>)[name];
  if (describe === undefined || describe === "generic") return [{ value: true, description: `${name}: ${JSON.stringify(value)}` }];
  return describe(value as never);
}

/**
 * A readable line for every permission the manifest declares, in DESCRIBE
 * order. A type with no specific text, or one this host does not know, gets
 * a `name: value` line, so nothing is left out of a prompt.
 */
export function getRequiredPermissions(manifest: ExtensionManifest): PermissionItem[] {
  const perms = manifest.permissions as Record<string, unknown>;
  const unknown = Object.keys(perms).filter((name) => !Object.hasOwn(DESCRIBE, name));
  const items: PermissionItem[] = [];
  for (const name of [...DESCRIBED_PERMISSIONS, ...unknown]) {
    const value = perms[name];
    if (value !== undefined && value !== null) items.push(...describePermission(name, value).map((line) => ({ type: name, ...line })));
    // A stdio MCP server is a process the worker starts: its line sits beside shell's.
    if (name === "shell" && declaresStdioMcpServer(manifest)) items.push({ type: "mcpProcess", value: true, description: MCP_TEXT.neutral });
  }
  return items;
}

/** The manifest fields the lines read: the permissions, and whether it runs a stdio MCP server. */
type GrantManifest = Pick<ExtensionManifest, "kind" | "mcpServers">;

/**
 * Readable lines for an approval's grants. Each grant is the canonical JSON
 * pair `[name, value]`. A grant this text does not describe still gets a
 * line, `name: value`, so nothing an approval covers is hidden.
 *
 * The stdio MCP line follows `processSpawn`, the host's verdict for this
 * release and these grants (process-spawn-policy.ts), not the manifest alone;
 * without a verdict it keeps the neutral line and never claims a start.
 */
export function describeGrants(grants: readonly string[], manifest: GrantManifest, processSpawn?: ProcessSpawnPolicy): string[] {
  const pairs = grants.map((grant) => JSON.parse(grant) as [string, unknown]);
  const permissions = Object.fromEntries(pairs) as ExtensionManifest["permissions"];
  const described = getRequiredPermissions({ ...manifest, permissions } as ExtensionManifest);
  const covered = new Set(described.map((item) => item.type));
  const other = pairs.filter(([name]) => !covered.has(name)).map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
  const lines = described.map((item) => (item.type === "mcpProcess" && processSpawn ? MCP_TEXT[processSpawn] : item.description));
  return [...lines, ...other];
}
