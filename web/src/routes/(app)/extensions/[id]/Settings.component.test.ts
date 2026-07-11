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

describe("Extension detail — secret settings fields", () => {
  const secretSchema = {
    ...settingsSchema,
    psa_api_token: {
      type: "secret",
      label: "PSA API token",
      storageKey: "psa-token",
    },
  };

  function seedSecretSettings(isSet: boolean) {
    mockResponses.settings.body = {
      schema: secretSchema,
      declaredDefaults: {},
      userValues: {},
      resolved: {},
      secrets: { psa_api_token: { isSet } },
    };
  }

  test("GET secrets payload drives the masked, never-prefilled input + Not set badge", async () => {
    seedSecretSettings(false);
    const { findByTestId } = render(ExtensionDetailPage);
    const input = (await findByTestId("schema-input-psa_api_token")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(await findByTestId("schema-secret-status-psa_api_token")).toHaveTextContent("Not set");
  });

  test("isSet=true shows the Set badge, the saved-state hint, and the Clear affordance", async () => {
    seedSecretSettings(true);
    const { findByTestId } = render(ExtensionDetailPage);
    expect(await findByTestId("schema-secret-status-psa_api_token")).toHaveTextContent("Set");
    expect(await findByTestId("schema-secret-hint-psa_api_token")).toHaveTextContent(
      "never shown again",
    );
    expect(await findByTestId("schema-secret-clear-psa_api_token")).toBeInTheDocument();
    // Never prefilled even when a value is stored server-side.
    const input = (await findByTestId("schema-input-psa_api_token")) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  test("typing a token + Save issues PUT /settings/user carrying the typed value", async () => {
    seedSecretSettings(false);
    const { findByTestId } = render(ExtensionDetailPage);
    const input = (await findByTestId("schema-input-psa_api_token")) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "tok-live-1234567890" } });
    await fireEvent.click(await findByTestId("settings-panel-user-save"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).endsWith("/api/extensions/ext-1/settings/user") &&
          (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.values.psa_api_token).toBe("tok-live-1234567890");
    });
  });

  test("Clear + Save issues PUT with the explicit empty-string clear", async () => {
    seedSecretSettings(true);
    const { findByTestId } = render(ExtensionDetailPage);
    await fireEvent.click(await findByTestId("schema-secret-clear-psa_api_token"));
    expect(await findByTestId("schema-secret-hint-psa_api_token")).toHaveTextContent(
      "Will be cleared when you save.",
    );
    await fireEvent.click(await findByTestId("settings-panel-user-save"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).endsWith("/api/extensions/ext-1/settings/user") &&
          (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.values.psa_api_token).toBe("");
    });
  });

  test("untouched secret field stays ABSENT from the saved values blob", async () => {
    seedSecretSettings(true);
    const { findByTestId } = render(ExtensionDetailPage);
    await fireEvent.click(await findByTestId("settings-panel-user-save"));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).endsWith("/api/extensions/ext-1/settings/user") &&
          (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect("psa_api_token" in body.values).toBe(false);
    });
  });
});
