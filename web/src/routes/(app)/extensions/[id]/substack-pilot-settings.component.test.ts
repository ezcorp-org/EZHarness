/**
 * Substack-pilot — settings panel render coverage.
 *
 * Mirrors the structure of `Settings.component.test.ts` but pins the
 * substack-pilot manifest fixture so the auto-generated SchemaForm
 * surfaces the three credential fields declared in
 * `docs/extensions/examples/substack-pilot/ezcorp.config.ts`:
 *   - substack_publication_url  (Publication URL,  pattern ^https?://[^\s]+$)
 *   - substack_session_token    (Session token,    pattern ^.+$)
 *   - substack_user_id          (User ID,          pattern ^\d+$)
 *
 * V2 settings schema has no `secret:true`, so the session-token input
 * is a plain `type="text"`. We assert presence, not masking — see the
 * substack-pilot extension build report for the V2-schema rationale.
 */

import { render, cleanup } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import ExtensionDetailPage from "./+page.svelte";

vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return {
    page: readable({ params: { id: "ext-substack-pilot" } }),
  };
});

vi.mock("$lib/stores/extensionSettings", () => ({
  invalidateExtensionSettings: vi.fn(),
}));

// Frontend fixture mirroring substack-pilot/ezcorp.config.ts. Kept inline
// (rather than importing the SDK helper) so this test stays a pure DOM
// render test with no `$server/extensions/sdk/define` transitive imports.
const substackPilotSettingsSchema = {
  substack_publication_url: {
    type: "text",
    label: "Publication URL",
    description: "e.g. https://yourname.substack.com",
    pattern: "^https?://[^\\s]+$",
  },
  substack_session_token: {
    type: "text",
    label: "Session token",
    description:
      "From the substack-mcp creator guide (kept locally, never logged).",
    pattern: "^.+$",
  },
  substack_user_id: {
    type: "text",
    label: "User ID",
    description: "Your Substack numeric user id.",
    pattern: "^\\d+$",
  },
} as const;

interface MockResponses {
  authMe: { ok: boolean; body: unknown };
  extension: { ok: boolean; body: unknown };
  settings: { ok: boolean; status?: number; body: unknown };
  violations: { ok: boolean; body: unknown };
  audit: { ok: boolean; body: unknown };
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
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return mockResponses.authMe.ok
        ? jsonResponse(mockResponses.authMe.body)
        : jsonResponse({}, 401);
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
        id: "ext-substack-pilot",
        name: "substack-pilot",
        version: "1.0.0",
        description:
          "Manage Substack post types with custom system prompts and AI-summarize-and-draft from URLs.",
        enabled: true,
        source: "bundled",
        installPath: "/tmp/substack-pilot",
        checksumVerified: true,
        consecutiveFailures: 0,
        manifest: {
          author: "EZCorp",
          entrypoint: "./index.ts",
          tools: [],
          permissions: { network: ["*"], shell: true },
          settings: substackPilotSettingsSchema,
        },
        grantedPermissions: { grantedAt: {} },
        createdAt: "2026-05-11",
      },
    },
    settings: {
      ok: true,
      body: {
        schema: substackPilotSettingsSchema,
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

describe("Extension detail — substack-pilot settings panel", () => {
  test("renders the three credential fields with labels and patterns from ezcorp.config.ts", async () => {
    const { findByLabelText, findByTestId } = render(ExtensionDetailPage);

    // Panel mounted with substack-pilot schema, not the empty placeholder.
    expect(await findByTestId("settings-panel-user")).toBeInTheDocument();

    const urlInput = (await findByLabelText("Publication URL")) as HTMLInputElement;
    const tokenInput = (await findByLabelText("Session token")) as HTMLInputElement;
    const userIdInput = (await findByLabelText("User ID")) as HTMLInputElement;

    // All three rendered as plain text inputs (V2 schema has no `secret:true`,
    // so the session token is unmasked — we assert presence only).
    expect(urlInput).toBeInTheDocument();
    expect(urlInput.tagName).toBe("INPUT");
    expect(urlInput.type).toBe("text");

    expect(tokenInput).toBeInTheDocument();
    expect(tokenInput.tagName).toBe("INPUT");
    expect(tokenInput.type).toBe("text");

    expect(userIdInput).toBeInTheDocument();
    expect(userIdInput.tagName).toBe("INPUT");
    expect(userIdInput.type).toBe("text");

    // Pattern attribute is wired through to the URL field (the primary
    // case worth pinning — the URL regex is the most fragile of the three
    // and is the one downstream cred validation depends on first).
    expect(urlInput.getAttribute("pattern")).toBe("^https?://[^\\s]+$");
    // Sanity-check the other two patterns are forwarded too.
    expect(tokenInput.getAttribute("pattern")).toBe("^.+$");
    expect(userIdInput.getAttribute("pattern")).toBe("^\\d+$");

    // Initial values are empty (no stored creds yet).
    expect(urlInput.value).toBe("");
    expect(tokenInput.value).toBe("");
    expect(userIdInput.value).toBe("");
  });

  test("each credential field renders inside a schema-field wrapper keyed by manifest field name", async () => {
    const { findByTestId } = render(ExtensionDetailPage);

    expect(
      await findByTestId("schema-field-substack_publication_url"),
    ).toBeInTheDocument();
    expect(
      await findByTestId("schema-field-substack_session_token"),
    ).toBeInTheDocument();
    expect(
      await findByTestId("schema-field-substack_user_id"),
    ).toBeInTheDocument();
  });
});
