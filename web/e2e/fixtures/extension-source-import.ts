import type { Page, Route } from "@playwright/test";
import { expect } from "./hydration.js";
import { stringify } from "devalue";

export async function setupSourceImportMock(page: Page, options: { status?: number; message?: string; installationId?: string; workspaceId?: string; reviewData?: () => Record<string, unknown> } = {}) {
  const installationId = options.installationId ?? "imported-installation";
  const workspaceId = options.workspaceId ?? "candidate-workspace";
  const submitted: Record<string, unknown>[] = [];
  const reviewRequests: Route[] = [];
  const unexpectedMutations: string[] = [];
  await page.route("**/extensions/import-source/__data.json**", route => route.fulfill({ json: {
    type: "data", nodes: [null, null, { type: "data", data: [{ canCreate: 1, targets: 2, projects: 3, selectedTarget: 4 }, true, [], [], ""], uses: {} }],
  } }));
  await page.route("**/api/extensions/**", async route => {
    const request = route.request();
    if (request.method() === "GET") return route.fallback();
    if (new URL(request.url()).pathname !== "/api/extensions/import-source") {
      unexpectedMutations.push(new URL(request.url()).pathname);
      return route.fulfill({ status: 403, json: { message: "Unexpected mutation in source-only fixture" } });
    }
    submitted.push(request.postDataJSON());
    return route.fulfill({ status: options.status ?? 202, json: options.message ? { message: options.message } : {
      installation: { id: installationId, enabled: false, activeReleaseId: null, grants: [] },
      workspace: { id: workspaceId, revision: 1 }, operation: { id: "candidate-build", state: "queued" },
    } });
  });
  await page.route("**/extensions/author**", async route => {
    reviewRequests.push(route);
    if (options.reviewData) await route.fulfill({ json: { type: "data", nodes: [null, null, { type: "data", data: JSON.parse(stringify(options.reviewData())), uses: {} }] } });
  });
  return {
    submitted, unexpectedMutations,
    async open() {
      await page.goto("/extensions");
      await page.getByRole("link", { name: "Choose source", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Import extension source", exact: true })).toBeVisible();
    },
    async expectReview() {
      await expect.poll(() => reviewRequests.length).toBeGreaterThan(0);
      const target = new URL(reviewRequests[0]!.request().url());
      expect(target.searchParams.get("installation")).toBe(installationId);
      expect(target.searchParams.get("workspace")).toBe(workspaceId);
      expect(unexpectedMutations).toEqual([]);
    },
    async close() { if (!options.reviewData) for (const route of reviewRequests) await route.abort(); },
  };
}
