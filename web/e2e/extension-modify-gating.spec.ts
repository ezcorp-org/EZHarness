/**
 * Extension detail page — "Modify" gating (creator-modify feature).
 *
 * Verifies the role/ownership/flag visibility matrix on
 * `/extensions/[id]`:
 *   - owner + modifiable           → Modify button (and click → reopen)
 *   - owner + NOT modifiable       → "ask an admin" hint, no button
 *   - non-owner non-admin          → no modify section at all
 *   - admin (not owner) + !bundled → admin "Allow modify" toggle
 *   - admin + bundled              → no toggle (bundled never modifiable)
 *
 * The server routes themselves are unit-tested
 * (`api-extensions-id-{modifiable,reopen}.server.test.ts`); this spec
 * locks the UI gate. The in-chat `modify_extension` tool + sensitive
 * permission card are boot-gated (bundled manifest + new capability)
 * and remain manual UAT.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const EXT_ID = "ext-weather";
const OWNER = "user-owner";

function meAs(id: string, role: "admin" | "member") {
  return { user: { id, email: `${id}@t.local`, name: id, role } };
}

function makeDetail(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: EXT_ID,
    name: "weather",
    version: "1.0.0",
    description: "A weather extension.",
    enabled: true,
    source: "local",
    installPath: "/tmp/weather",
    checksumVerified: true,
    consecutiveFailures: 0,
    manifest: {
      author: "Test",
      entrypoint: "./index.ts",
      persistent: false,
      tools: [{ name: "w", description: "d", inputSchema: { type: "object", properties: {} } }],
      permissions: {},
    },
    grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    creatorUserId: null,
    modifiable: false,
    isBundled: false,
    ...over,
  };
}

const proj = makeProject({ id: "proj-1", name: "P" });

test.describe("extension detail — modify gating", () => {
  test("owner + modifiable → Modify button; click issues reopen + navigates", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [proj],
      routes: {
        [`/api/extensions/${EXT_ID}`]: () =>
          makeDetail({ creatorUserId: OWNER, modifiable: true }),
        "/api/auth/me": () => meAs(OWNER, "member"),
      },
    });
    await page.route(`**/api/extensions/${EXT_ID}/reopen`, (route) =>
      route.fulfill({ json: { draftId: "d-1", name: "weather" } }),
    );

    await page.goto(`/extensions/${EXT_ID}`);

    await expect(page.getByTestId("modify-extension-section")).toBeVisible({
      timeout: 5000,
    });
    const btn = page.getByTestId("modify-extension-button");
    await expect(btn).toBeVisible();
    // Toggle is ALWAYS shown now; a non-admin sees it but disabled.
    await expect(page.getByTestId("modifiable-toggle")).toBeVisible();
    await expect(page.getByTestId("modifiable-toggle")).toBeDisabled();

    const reopenReq = page.waitForRequest(
      (r) =>
        r.url().includes(`/api/extensions/${EXT_ID}/reopen`) &&
        r.method() === "POST",
    );
    await btn.click();
    await reopenReq;
    await page.waitForURL(/\/extensions\/author\?prefill=d-1/, { timeout: 5000 });
  });

  test("owner + NOT modifiable → ask-an-admin hint, no button", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [proj],
      routes: {
        [`/api/extensions/${EXT_ID}`]: () =>
          makeDetail({ creatorUserId: OWNER, modifiable: false }),
        "/api/auth/me": () => meAs(OWNER, "member"),
      },
    });
    await page.goto(`/extensions/${EXT_ID}`);

    await expect(page.getByTestId("modify-extension-section")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("modify-extension-button")).toHaveCount(0);
    // Toggle shown but disabled for the non-admin owner.
    await expect(page.getByTestId("modifiable-toggle")).toBeVisible();
    await expect(page.getByTestId("modifiable-toggle")).toBeDisabled();
    await expect(
      page.getByText("An admin must enable modification", { exact: false }),
    ).toBeVisible();
  });

  test("non-owner non-admin → section + toggle shown but disabled", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [proj],
      routes: {
        [`/api/extensions/${EXT_ID}`]: () =>
          makeDetail({ creatorUserId: OWNER, modifiable: true }),
        "/api/auth/me": () => meAs("someone-else", "member"),
      },
    });
    await page.goto(`/extensions/${EXT_ID}`);

    // Always-shown section; the toggle is visible but non-interactive
    // for a non-admin, and there's no Modify button (not the owner).
    await expect(page.getByTestId("modify-extension-section")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("modifiable-toggle")).toBeVisible();
    await expect(page.getByTestId("modifiable-toggle")).toBeDisabled();
    await expect(page.getByTestId("modify-extension-button")).toHaveCount(0);
  });

  test("admin (not owner) + !bundled → admin toggle visible, no Modify button", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [proj],
      routes: {
        [`/api/extensions/${EXT_ID}`]: () =>
          makeDetail({ creatorUserId: OWNER, modifiable: false, isBundled: false }),
        "/api/auth/me": () => meAs("admin-1", "admin"),
      },
    });
    await page.goto(`/extensions/${EXT_ID}`);

    await expect(page.getByTestId("modify-extension-section")).toBeVisible({
      timeout: 5000,
    });
    // Admin: toggle visible AND interactive.
    await expect(page.getByTestId("modifiable-toggle")).toBeVisible();
    await expect(page.getByTestId("modifiable-toggle")).toBeEnabled();
    await expect(page.getByTestId("modify-extension-button")).toHaveCount(0);
  });

  test("admin + bundled → section shown, toggle disabled + 'built-in' note", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [proj],
      routes: {
        [`/api/extensions/${EXT_ID}`]: () =>
          makeDetail({ creatorUserId: null, modifiable: false, isBundled: true }),
        "/api/auth/me": () => meAs("admin-1", "admin"),
      },
    });
    await page.goto(`/extensions/${EXT_ID}`);

    // Always shown now — even for bundled, and even to an admin — but
    // the toggle is non-interactive with an explanation (server also
    // 400s a bundled modifiable flip; this is just the affordance).
    await expect(page.getByTestId("modify-extension-section")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId("modifiable-toggle")).toBeVisible();
    await expect(page.getByTestId("modifiable-toggle")).toBeDisabled();
    await expect(
      page.getByText("built-in — not modifiable", { exact: false }),
    ).toBeVisible();
  });
});
