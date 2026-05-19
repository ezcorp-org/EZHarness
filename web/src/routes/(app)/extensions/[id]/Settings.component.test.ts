/**
 * DOM tests for the Settings section on the extension detail page.
 *
 * Pins:
 *   - "No settings" placeholder when the manifest declares no schema
 *   - User panel renders + Save triggers PUT /user
 *   - Reset triggers DELETE /user and refetches
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import ExtensionDetailPage from "./+page.svelte";

vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return {
    page: readable({ params: { id: "ext-1" } }),
  };
});

vi.mock("$lib/stores/extensionSettings", () => ({
  invalidateExtensionSettings: vi.fn(),
}));

interface MockResponses {
  authMe: { ok: boolean; body: unknown };
  extension: { ok: boolean; body: unknown };
  settings: { ok: boolean; status?: number; body: unknown };
  violations: { ok: boolean; body: unknown };
  audit: { ok: boolean; body: unknown };
  putUser?: { ok: boolean; body?: unknown };
  deleteUser?: { ok: boolean; body?: unknown };
}

let fetchMock: ReturnType<typeof vi.fn>;
let mockResponses: MockResponses;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/auth/me")) {
      return mockResponses.authMe.ok
        ? jsonResponse(mockResponses.authMe.body)
        : jsonResponse({}, 401);
    }
    if (url.match(/\/api\/extensions\/[^/]+\/settings\/user$/)) {
      if (method === "PUT") {
        const r = mockResponses.putUser ?? { ok: true };
        return r.ok ? jsonResponse({}) : jsonResponse({}, 500);
      }
      if (method === "DELETE") {
        const r = mockResponses.deleteUser ?? { ok: true };
        return r.ok ? jsonResponse({}) : jsonResponse({}, 500);
      }
    }
    if (url.match(/\/api\/extensions\/[^/]+\/settings$/)) {
      return mockResponses.settings.ok
        ? jsonResponse(mockResponses.settings.body)
        : new Response("{}", { status: mockResponses.settings.status ?? 500 });
    }
    if (url.match(/\/api\/extensions\/[^/]+\/violations$/)) {
      return mockResponses.violations.ok
        ? jsonResponse(mockResponses.violations.body)
        : jsonResponse({}, 500);
    }
    if (url.match(/\/api\/extensions\/[^/]+\/audit$/)) {
      return mockResponses.audit.ok
        ? jsonResponse(mockResponses.audit.body)
        : jsonResponse({}, 500);
    }
    if (url.match(/\/api\/extensions\/[^/]+$/)) {
      return mockResponses.extension.ok
        ? jsonResponse(mockResponses.extension.body)
        : jsonResponse({}, 404);
    }
    return jsonResponse({});
  }) as typeof fetch;
}

beforeEach(() => {
  mockResponses = {
    authMe: { ok: true, body: { user: { role: "user" } } },
    extension: {
      ok: true,
      body: {
        id: "ext-1",
        name: "kokoro-tts",
        version: "1.0.0",
        description: "TTS",
        enabled: true,
        source: "bundled",
        installPath: "/tmp/x",
        checksumVerified: true,
        consecutiveFailures: 0,
        manifest: {
          entrypoint: "./index.ts",
          tools: [],
          permissions: {},
        },
        grantedPermissions: { grantedAt: {} },
        createdAt: "2026-01-01",
      },
    },
    settings: {
      ok: true,
      body: {
        schema: {},
        declaredDefaults: {},
        userValues: {},
        resolved: {},
      },
    },
    violations: { ok: true, body: [] },
    audit: { ok: true, body: { entries: [] } },
  };
  fetchMock = vi.fn().mockImplementation(buildFetch());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settingsSchema = {
  voice: {
    type: "select",
    label: "Voice",
    options: [
      { value: "af_bella", label: "Bella" },
      { value: "bf_emma", label: "Emma" },
    ],
    default: "af_bella",
  },
  speed: {
    type: "number",
    label: "Speed",
    min: 0.5,
    max: 2.0,
    step: 0.05,
    default: 1.0,
  },
};

describe("Extension detail — Settings section", () => {
  test('renders "no settings" placeholder when manifest schema is empty', async () => {
    const { findByTestId } = render(ExtensionDetailPage);
    expect(await findByTestId("extension-settings-empty")).toBeInTheDocument();
  });

  test("user panel renders when schema is non-empty; no global panel exists", async () => {
    mockResponses.settings.body = {
      schema: settingsSchema,
      declaredDefaults: { voice: "af_bella", speed: 1.0 },
      userValues: {},
      resolved: { voice: "af_bella", speed: 1.0 },
    };
    const { findByTestId, queryByTestId } = render(ExtensionDetailPage);
    expect(await findByTestId("settings-panel-user")).toBeInTheDocument();
    expect(queryByTestId("settings-panel-global")).toBeNull();
  });

  test("admin sees the same single user panel — no global panel for anyone", async () => {
    mockResponses.authMe.body = { user: { role: "admin" } };
    mockResponses.settings.body = {
      schema: settingsSchema,
      declaredDefaults: {},
      userValues: {},
      resolved: {},
    };
    const { findByTestId, queryByTestId } = render(ExtensionDetailPage);
    expect(await findByTestId("settings-panel-user")).toBeInTheDocument();
    expect(queryByTestId("settings-panel-global")).toBeNull();
  });

  test("Save on user panel issues PUT /settings/user", async () => {
    mockResponses.settings.body = {
      schema: settingsSchema,
      declaredDefaults: {},
      userValues: { voice: "af_bella", speed: 1.0 },
      resolved: { voice: "af_bella", speed: 1.0 },
    };
    const { findByTestId } = render(ExtensionDetailPage);
    const saveBtn = await findByTestId("settings-panel-user-save");
    await fireEvent.click(saveBtn);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({ url: String(c[0]), method: (c[1] as RequestInit | undefined)?.method ?? "GET" }));
      expect(
        calls.some((c) => c.url.endsWith("/api/extensions/ext-1/settings/user") && c.method === "PUT"),
      ).toBe(true);
    });
  });

  test("Reset on user panel issues DELETE /settings/user", async () => {
    mockResponses.settings.body = {
      schema: settingsSchema,
      declaredDefaults: {},
      userValues: { voice: "bf_emma", speed: 1.0 },
      resolved: { voice: "bf_emma", speed: 1.0 },
    };
    const { findByTestId } = render(ExtensionDetailPage);
    const resetBtn = await findByTestId("settings-panel-user-reset");
    await fireEvent.click(resetBtn);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => ({ url: String(c[0]), method: (c[1] as RequestInit | undefined)?.method ?? "GET" }));
      expect(
        calls.some((c) => c.url.endsWith("/api/extensions/ext-1/settings/user") && c.method === "DELETE"),
      ).toBe(true);
    });
  });

  test("settings 409 (no schema declared) keeps the section showing the empty placeholder", async () => {
    mockResponses.settings = { ok: false, status: 409, body: {} };
    const { findByTestId } = render(ExtensionDetailPage);
    expect(await findByTestId("extension-settings-section")).toBeInTheDocument();
    expect(await findByTestId("extension-settings-empty")).toBeInTheDocument();
  });
});
