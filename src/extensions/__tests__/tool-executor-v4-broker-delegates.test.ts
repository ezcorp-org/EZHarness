import { expect, test } from "bun:test";
import { ToolExecutor } from "../tool-executor";
import type { ExtensionRegistry } from "../registry";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";

test.each([
  ["handlePiHostApi", "ezcorp/api.request"],
  ["handlePiProjectPullRequest", "ezcorp/project.openPr"],
  ["handlePiProjectGit", "ezcorp/project.git"],
  ["handlePiNetworkBroker", "ezcorp/network.fetch"],
  ["handlePiCredentialBroker", "ezcorp/env.get"],
  ["handlePiGithubProjects", "ezcorp/github-projects.listBoards"],
] as const)("%s preserves broker provenance rejection and request identity", async (handler, method) => {
  let reads = 0;
  const registry = {
    getManifest: () => { reads++; return null; },
    getGrantedPermissions: () => { reads++; return null; },
  } as unknown as ExtensionRegistry;
  const executor = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
  const response = await executor[handler]("untrusted", { jsonrpc: "2.0", id: "request-id", method, params: {} });
  expect(response.id).toBe("request-id");
  expect(response.error).toBeDefined();
  expect(response.result).toBeUndefined();
  expect(reads).toBe(handler === "handlePiGithubProjects" ? 2 : 0);
});
