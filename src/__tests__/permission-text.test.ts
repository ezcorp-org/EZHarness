import { describe, expect, test } from "bun:test";
import { describeGrants, getRequiredPermissions } from "../extensions/permission-text";
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
    expect(describeGrants(['["secretRead",["github"]]', '["shell",false]'], {})).toEqual(['secretRead: ["github"]', "shell: false"]);
  });

  test("permissions.ts re-exports the same function the CLI uses", () => {
    expect(fromPermissions).toBe(getRequiredPermissions);
  });
});
