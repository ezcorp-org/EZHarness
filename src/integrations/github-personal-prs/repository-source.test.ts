import { beforeEach, expect, mock, test } from "bun:test";
import type { ApprovedBase } from "./github-source";
import { validateSnapshot } from "./snapshot";
const approved: ApprovedBase = { repositoryId: 42, fullName: "owner/repo", baseRef: "main", baseSha: "a".repeat(40), snapshot: validateSnapshot([]) };

let status = "ready";
let repository: { fullName: string } | null = { fullName: "owner/repo" };
let wireError = false;
const events: unknown[] = [];
mock.module("../github-user/broker", () => ({
  checkRepository: async (input: unknown) => { events.push(input); return { status, repository }; },
  withUserToken: async (input: unknown, work: (token: string) => Promise<unknown>) => { events.push(input); return work("host-token"); },
}));
mock.module("../github-user/transport", () => ({ githubApi: async (token: string, path: string) => { events.push({ token, path }); if (wireError) throw new Error("GitHub unavailable"); return approved; } }));
mock.module("./github-source", () => ({ fetchApprovedBase: async (input: unknown, transport: (path: string, token: string) => Promise<unknown>) => {
  events.push(input); return transport("/pinned-source", "host-token");
} }));
const { approvedRepositorySource } = await import("./repository-source");
beforeEach(() => { status = "ready"; repository = { fullName: "owner/repo" }; wireError = false; events.length = 0; });
test("source selection uses the actor account and approved repository through one host credential boundary", async () => {
  expect(await approvedRepositorySource("owner", 42, "main", "operation")).toEqual({ source: approved });
  expect(events).toEqual([{ userId: "owner", repositoryId: 42 }, { userId: "owner", repositoryId: 42, kind: "import", operationId: "operation" },
    { repositoryId: 42, fullName: "owner/repo", baseRef: "main", token: "host-token" }, { token: "host-token", path: "/pinned-source" }]);
});
test("denied and absent repository stop before token access", async () => {
  status = "disabled";
  expect(await approvedRepositorySource("owner", 42, "main")).toHaveProperty("blocked", "disabled");
  repository = null; status = "ready";
  expect(await approvedRepositorySource("owner", 42, "main")).toEqual({ blocked: "ready" });
  expect(events).toHaveLength(2);
});
test("provider failure is preserved for the existing service error mapping", async () => {
  wireError = true;
  await expect(approvedRepositorySource("owner", 42, "main")).rejects.toThrow("GitHub unavailable");
});
