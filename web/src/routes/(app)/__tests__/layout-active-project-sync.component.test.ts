/**
 * INTEGRATION test for the `(app)` layout's URL → `activeProjectId` sync.
 *
 * The layout mirrors the URL's project segment into `store.activeProjectId`
 * (and `localStorage`) so a bookmark / refresh / direct link restores the
 * workspace. The regression this pins: the sync used to read
 * `page.params.id`, and `[id]` is NOT unique to `/project/[id]` —
 * `/extensions/[id]`, `/extensions/[id]/audit`, `/marketplace/[id]` and
 * `/runs/[id]` all declare the same param name. Opening an extension
 * therefore wrote the EXTENSION id into `activeProjectId`, kicking the user
 * out of their project.
 *
 * The pathname parser (`projectIdFromPath`) is unit-tested in
 * `src/__tests__/resume-path.unit.test.ts`. What that CANNOT prove is the
 * wiring — that the layout feeds it the pathname (not the param) and routes
 * the result through `setActiveProjectId`. A revert to `page.params.id`
 * keeps the unit suite green and fails here.
 *
 * Harness: mock the WS client + api fetchers (same shape as the other
 * `stores.svelte.ts` integration suites), stub `fetch`, and mount the REAL
 * layout once per route shape.
 */

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createRawSnippet } from "svelte";

const { pageStub } = vi.hoisted(() => ({
  pageStub: {
    url: new URL("http://localhost/"),
    params: {} as Record<string, string>,
    route: { id: null as string | null },
    data: {},
    form: null,
    state: {},
    error: null,
    status: 200,
  },
}));

vi.mock("$app/state", () => ({
  page: pageStub,
  navigating: null,
  updated: { current: false, check: async () => false },
}));

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  preloadData: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
}));

vi.mock("$lib/ws", () => ({
  createWSClient: () => ({
    subscribe: () => () => {},
    close: () => {},
    manualRetry: () => {},
  }),
}));

vi.mock("$lib/api", () => ({
  fetchAgents: () => Promise.resolve([]),
  fetchRuns: () => Promise.resolve([]),
  fetchProjects: () => Promise.resolve([]),
  fetchSettings: () => Promise.resolve({}),
  fetchAgentConfigs: () => Promise.resolve([]),
  fetchWorkflows: () => Promise.resolve([]),
  createConversation: () => Promise.resolve({ id: "conv-new" }),
}));

import AppLayout from "../+layout.svelte";
import { store, setActiveProjectId } from "$lib/stores.svelte.js";
import { ACTIVE_PROJECT_KEY } from "$lib/resume-path.js";

const children = createRawSnippet(() => ({
  render: () => `<div data-testid="layout-child"></div>`,
}));

/** Mount the real layout with the URL bar pointing at `pathname`. */
function mountAt(pathname: string, params: Record<string, string> = {}) {
  pageStub.url = new URL(`http://localhost${pathname}`);
  pageStub.params = params;
  return render(AppLayout, { props: { children } });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
  // Start every case inside a real project, as a user would be.
  setActiveProjectId("proj-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("(app) layout — activeProjectId follows the URL's project segment", () => {
  test("a project route syncs the store and localStorage", () => {
    mountAt("/project/proj-2/chat/conv-9", { id: "proj-2", convId: "conv-9" });

    expect(store.activeProjectId).toBe("proj-2");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe("proj-2");
  });

  test("the global workspace route is a normal project segment", () => {
    mountAt("/project/global/chat", { id: "global" });

    expect(store.activeProjectId).toBe("global");
  });

  // The regression: every one of these routes declares an `[id]` param that
  // is NOT a project id.
  test.each([
    ["extension detail", "/extensions/ext-1", { id: "ext-1" }],
    ["extension audit", "/extensions/ext-1/audit", { id: "ext-1" }],
    ["marketplace listing", "/marketplace/listing-9", { id: "listing-9" }],
    ["run detail", "/runs/run-3", { id: "run-3" }],
  ])("%s leaves the active project alone", (_label, pathname, params) => {
    mountAt(pathname, params);

    expect(store.activeProjectId).toBe("proj-1");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe("proj-1");
  });

  test("a param-less route leaves the active project alone", () => {
    mountAt("/extensions");

    expect(store.activeProjectId).toBe("proj-1");
  });
});
