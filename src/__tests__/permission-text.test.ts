import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { join } from "node:path";
import { DESCRIBED_PERMISSIONS, describeGrants, getRequiredPermissions } from "../extensions/permission-text";
import { getRequiredPermissions as fromPermissions } from "../extensions/permissions";
import type { ExtensionManifest } from "../extensions/types";

const stdioMcp = { kind: "mcp", mcpServers: [{ name: "weather", transport: "stdio" }] } as Pick<ExtensionManifest, "kind" | "mcpServers">;

describe("describeGrants", () => {
  test("reads each grant with the same text as the install prompt", () => {
    const grants = ['["env",["API_KEY"]]', '["filesystem",["/data/"]]', '["network",["api.example.com"]]', '["shell",true]', '["storage",true]'];
    const lines = describeGrants(grants, stdioMcp, "allow");
    const permissions = { env: ["API_KEY"], filesystem: ["/data/"], network: ["api.example.com"], shell: true, storage: true };
    // The same text as the CLI and the install prompt, except the MCP line, which the verdict decides.
    const shared = getRequiredPermissions({ ...stdioMcp, permissions } as ExtensionManifest).map((item) => item.description);
    expect(lines).toEqual(shared.map((line) => (line.startsWith("Has a stdio MCP server") ? "Starts its MCP server process (process spawning allowed)" : line)));
    expect(lines).toContain("Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)");
    expect(lines).toContain("Starts its MCP server process (process spawning allowed)");
  });

  test("the stdio MCP line follows the host's process verdict, not the manifest alone", () => {
    const mcpLine = "Starts its MCP server process (process spawning allowed)";
    const blocked = "Cannot start its MCP server process: starting processes needs the shell permission";
    expect(describeGrants([], stdioMcp, "deny")).toEqual([blocked]);
    expect(describeGrants([], stdioMcp, "allow")).toEqual([mcpLine]);
    // No verdict (the runner could not read the artifact): the neutral line, never a claim.
    expect(describeGrants([], stdioMcp)).toEqual(["Has a stdio MCP server: it can start its server only if the release is a plain MCP bridge or has the shell permission"]);
  });

  test("a grant the text does not describe still gets a line", () => {
    expect(describeGrants(['["futureThing",{"a":1}]', '["secretRead",["github"]]', '["shell",false]'], {})).toEqual(["Read the raw credential for github", 'futureThing: {"a":1}', "shell: false"]);
  });

  test("permissions.ts re-exports the same function the CLI uses", () => {
    expect(fromPermissions).toBe(getRequiredPermissions);
  });
});

/** Every key of the manifest permissions type, read with the TypeScript checker. */
function manifestPermissionNames(): string[] {
  const root = join(import.meta.dir, "../..");
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const file = join(root, "src/extensions/permission-text.ts");
  const program = ts.createProgram([file], { ...config!.options, noEmit: true });
  const checker = program.getTypeChecker();
  const alias = program.getSourceFile(file)!.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "ManifestPermissions")!;
  return checker.getPropertiesOfType(checker.getTypeAtLocation(alias.name)).map((property) => property.name).sort();
}

describe("every manifest permission type has text", () => {
  test("the described list is exactly the keys of the manifest permissions type", () => {
    const names = manifestPermissionNames();
    expect(names.length).toBeGreaterThan(20);
    expect([...DESCRIBED_PERMISSIONS].sort()).toEqual(names);
  });

  test("each permission type reads as a sentence; an empty or false one adds no line", () => {
    const permissions = {
      network: ["api.example.com"], filesystem: ["/data/"], shell: true, env: ["KEY"], storage: true,
      networkTcp: ["db.example.com:5432"], secretRead: ["github"],
      hostApi: { routes: [{ method: "GET", path: "/api/items" }], events: true },
      lifecycleHooks: true, taskEvents: true, loopEvents: true,
      spawnAgents: { maxPerHour: 5, maxConcurrent: 2 }, agentConfig: "read",
      eventSubscriptions: { events: ["tool:complete"], includeFullPayload: true },
      webhooks: ["deploy"], triggers: { maxCron: 2, maxWebhooks: 1, maxRunsPerDay: 10 },
      workflows: { names: ["nightly"], maxRunsPerHour: 3 }, appendMessages: { excludedDefault: true },
      llm: { providers: ["openai"], maxCallsPerHour: 10, maxCallsPerDay: 100 },
      memory: { access: "write" }, lessons: { access: "read" }, schedule: { crons: ["0 9 * * *"] },
      search: "inherit", mcpInvoke: true, rbacScopes: [{ name: "ops", description: "Ops" }], custom: { drafts: { kinds: ["note"] } },
    };
    expect(getRequiredPermissions({ permissions } as unknown as ExtensionManifest).map((item) => item.description)).toEqual([
      "Network access to api.example.com",
      "Filesystem access to /data/",
      "Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)",
      "Read environment variable KEY",
      "Persistent key-value storage",
      "Opaque TCP connection to db.example.com:5432",
      "Read the raw credential for github",
      "Call the host API GET /api/items",
      "Receive host API events",
      "Run install and uninstall hooks",
      "Post task-panel updates in the conversation that calls it",
      "Send approval notices for its own loops",
      "Start sub-agent runs (at most 5 per hour, 2 at a time)",
      "Read your agent configurations",
      "Receive these app events: tool:complete (with full tool input and output)",
      "Receive webhook deliveries on deploy",
      "Create its own cron and webhook triggers (cron limit 2, webhook limit 1, 10 runs per day)",
      "Run the workflows nightly (at most 3 per hour)",
      "Add messages to the conversation",
      "Call language models from openai (at most 10 calls per hour, 100 per day)",
      "Read and write your memories",
      "Read lessons",
      "Run on a schedule: 0 9 * * *",
      "Run web searches",
      "Call the tools of its MCP server",
      'rbacScopes: [{"name":"ops","description":"Ops"}]',
      'custom: {"drafts":{"kinds":["note"]}}',
    ]);
    const off = { shell: false, storage: false, lifecycleHooks: false, taskEvents: false, loopEvents: false, search: false, mcpInvoke: false, eventSubscriptions: [], hostApi: { routes: [], events: false }, triggers: {}, workflows: { names: ["w"] } };
    expect(getRequiredPermissions({ permissions: off } as unknown as ExtensionManifest).map((item) => item.description)).toEqual([
      "Create its own cron and webhook triggers",
      "Run the workflows w",
    ]);
  });

  test("a permission outside the six original ones gets its own readable line", () => {
    const manifest = { kind: "extension", permissions: { spawnAgents: { maxPerHour: 5, maxConcurrent: 2 }, schedule: { crons: ["0 9 * * *"] } } } as unknown as ExtensionManifest;
    expect(getRequiredPermissions(manifest).map((item) => item.description)).toEqual([
      "Start sub-agent runs (at most 5 per hour, 2 at a time)",
      "Run on a schedule: 0 9 * * *",
    ]);
  });

  test("the approval card and the CLI read a grant the same way", () => {
    const manifest = { permissions: { spawnAgents: { maxPerHour: 5 }, rbacScopes: [{ name: "ops", description: "Ops" }] } } as unknown as ExtensionManifest;
    const cli = getRequiredPermissions(manifest).map((item) => item.description);
    expect(describeGrants(['["rbacScopes",[{"name":"ops","description":"Ops"}]]', '["spawnAgents",{"maxPerHour":5}]'], {})).toEqual(cli);
    expect(cli).toEqual(["Start sub-agent runs (at most 5 per hour)", 'rbacScopes: [{"name":"ops","description":"Ops"}]']);
  });
});
