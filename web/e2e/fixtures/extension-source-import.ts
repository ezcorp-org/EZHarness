import type { Page, Route } from "@playwright/test";
import { expect } from "./hydration.js";
import { stringify } from "devalue";

type AuthorReviewOptions = {
  installationId: string;
  workspaceId?: string;
  reviewData?: () => Record<string, unknown>;
};

function disabledAuthorReviewData(installationId: string): Record<string, unknown> {
  const installation = {
    id: installationId,
    ownerId: "mock-owner",
    scope: "global",
    activeReleaseId: null,
    generation: 0,
    enabled: false,
    uninstalled: false,
    status: "disabled",
    grants: [],
    acknowledgedGeneration: 0,
  };
  return {
    installations: [installation],
    state: { installation, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} },
    workspace: null,
    files: {},
    canApprove: false,
    canBindProject: false,
    projects: [],
    projectBinding: null,
  };
}

/**
 * Fulfil the SvelteKit author-page data request with a disabled candidate.
 * This keeps mock detail-page tests on the real client navigation path while
 * proving that the destination rendered instead of merely changing its URL.
 */
export async function setupAuthorReviewMock(page: Page, options: AuthorReviewOptions) {
  const reviewRequests: Route[] = [];
  const reviewResponses: Array<{ url: string; status: number; ok: boolean }> = [];
  const authorDataPattern = "**/extensions/author/__data.json**";
  const matchesReviewTarget = (url: URL, origin: string) =>
    url.origin === origin
    && url.pathname === "/extensions/author/__data.json"
    && url.searchParams.get("installation") === options.installationId
    && url.searchParams.get("workspace") === (options.workspaceId ?? null);
  const routeHandler = async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (!matchesReviewTarget(requestUrl, new URL(page.url()).origin)) return route.fallback();
    reviewRequests.push(route);
    await route.fulfill({
      status: 200,
      json: {
        type: "data",
        nodes: [null, null, { type: "data", data: JSON.parse(stringify(options.reviewData?.() ?? disabledAuthorReviewData(options.installationId))), uses: {} }],
      },
    });
  };
  const responseHandler = (response: import("@playwright/test").Response) => {
    const url = new URL(response.url());
    if (matchesReviewTarget(url, new URL(page.url()).origin)) {
      reviewResponses.push({ url: response.url(), status: response.status(), ok: response.ok() });
    }
  };
  await page.route(authorDataPattern, routeHandler);
  page.on("response", responseHandler);

  return {
    async expectReview() {
      const pageOrigin = new URL(page.url()).origin;
      await expect.poll(() => reviewRequests.find(route => matchesReviewTarget(new URL(route.request().url()), pageOrigin)) ?? null).not.toBeNull();
      const request = reviewRequests.find(route => matchesReviewTarget(new URL(route.request().url()), pageOrigin));
      expect(request).toBeDefined();
      await expect.poll(() => reviewResponses.find(({ url }) => matchesReviewTarget(new URL(url), pageOrigin)) ?? null).not.toBeNull();
      const response = reviewResponses.find(({ url }) => matchesReviewTarget(new URL(url), pageOrigin));
      expect(response).toEqual(expect.objectContaining({ status: 200, ok: true }));
      await expect.poll(() => {
        const destination = new URL(page.url());
        return destination.origin === pageOrigin
          && destination.pathname === "/extensions/author"
          && destination.searchParams.get("installation") === options.installationId
          && destination.searchParams.get("workspace") === (options.workspaceId ?? null);
      }).toBe(true);
      await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
      await expect(page.locator(".state-badge")).toHaveText("disabled · generation 0");
    },
    async close() {
      await page.unroute(authorDataPattern, routeHandler);
      page.off("response", responseHandler);
    },
  };
}

export async function setupSourceImportMock(page: Page, options: { status?: number; message?: string; installationId?: string; workspaceId?: string; reviewData?: () => Record<string, unknown> } = {}) {
  const installationId = options.installationId ?? "imported-installation";
  const workspaceId = options.workspaceId ?? "candidate-workspace";
  const submitted: Record<string, unknown>[] = [];
  const unexpectedMutations: string[] = [];
  const review = await setupAuthorReviewMock(page, { installationId, workspaceId, reviewData: options.reviewData });
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
  return {
    submitted, unexpectedMutations,
    async open() {
      await page.goto("/extensions");
      await page.getByRole("link", { name: "Choose source", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Import extension source", exact: true })).toBeVisible();
    },
    async expectReview() {
      await review.expectReview();
      expect(unexpectedMutations).toEqual([]);
    },
    async close() { await review.close(); },
  };
}
