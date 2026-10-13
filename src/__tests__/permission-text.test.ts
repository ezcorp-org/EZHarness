import { describe, expect, test } from "bun:test";
import { describeGrants, getRequiredPermissions } from "../extensions/permission-text";
import { getRequiredPermissions as fromPermissions } from "../extensions/permissions";
import type { ExtensionManifest } from "../extensions/types";

const stdioMcp = { kind: "mcp", mcpServers: [{ name: "weather", transport: "stdio" }] } as Pick<ExtensionManifest, "kind" | "mcpServers">;

describe("describeGrants", () => {
  test("reads each grant with the same text as the install prompt", () => {
    const grants = ['["env",["API_KEY"]]', '["filesystem",["/data/"]]', '["network",["api.example.com"]]', '["shell",true]', '["storage",true]'];
    const lines = describeGrants(grants, stdioMcp);
    const permissions = { env: ["API_KEY"], filesystem: ["/data/"], network: ["api.example.com"], shell: true, storage: true };
    expect(lines).toEqual(getRequiredPermissions({ ...stdioMcp, permissions } as ExtensionManifest).map((item) => item.description));
    expect(lines).toContain("Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)");
    expect(lines).toContain("Starts its MCP server process (process spawning allowed)");
  });

  test("a grant the text does not describe still gets a line", () => {
    expect(describeGrants(['["secretRead",["github"]]', '["shell",false]'], {})).toEqual(['secretRead: ["github"]', "shell: false"]);
  });

  test("permissions.ts re-exports the same function the CLI uses", () => {
    expect(fromPermissions).toBe(getRequiredPermissions);
  });
});
