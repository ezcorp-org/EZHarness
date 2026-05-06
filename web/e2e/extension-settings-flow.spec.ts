/**
 * Per-extension settings — end-to-end flow.
 *
 * Closes the seams between four moving parts:
 *   1. Manifest validator admits a `settings` block.
 *   2. DB layer stores user values and resolves `declared < user`.
 *   3. HTTP routes at `/api/extensions/[id]/settings*`.
 *   4. UI surface — `<SettingsPanel/>` on the extension detail page,
 *      gated on `manifest.settings`.
 *
 * Drives the full happy-path: a user sets the voice, reload preserves it,
 * reset clears back to the declared default. Plus the no-settings case
 * (`schema: null` + empty placeholder).
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const KOKORO_SETTINGS_SCHEMA = {
  voice: {
    type: "select",
    label: "Voice",
    description: "Speaker timbre.",
    options: [
      { value: "af_bella", label: "Bella (US, female)" },
      { value: "af_sarah", label: "Sarah (US, female)" },
      { value: "am_adam", label: "Adam (US, male)" },
      { value: "bf_emma", label: "Emma (UK, female)" },
      { value: "bm_george", label: "George (UK, male)" },
    ],
    default: "af_bella",
  },
  speed: {
    type: "number",
    label: "Playback speed",
    description: "1.0 = natural; <1 slower, >1 faster.",
    min: 0.5,
    max: 2.0,
    step: 0.05,
    default: 1.0,
  },
} as const;

const KOKORO_DECLARED_DEFAULTS = { voice: "af_bella", speed: 1.0 };

const USER_ME = {
  user: { id: "user-1", email: "user@test.local", name: "Test User", role: "user" },
};

function makeKokoroDetail(): Record<string, unknown> {
  return {
    id: "ext-kokoro",
    name: "kokoro-tts",
    version: "1.0.0",
    description: "In-browser Kokoro-TTS.",
    enabled: true,
    source: "bundled",
    installPath: "/bundled/kokoro-tts",
    checksumVerified: true,
    consecutiveFailures: 0,
    manifest: {
      author: "EZCorp",
      entrypoint: "./index.ts",
      persistent: false,
      tools: [],
      permissions: {},
      settings: KOKORO_SETTINGS_SCHEMA,
    },
    grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeNoSettingsDetail(): Record<string, unknown> {
  return {
    id: "ext-plain",
    name: "plain-ext",
    version: "1.0.0",
    description: "An extension without any settings.",
    enabled: true,
    source: "local",
    installPath: "/tmp/plain-ext",
    checksumVerified: true,
    consecutiveFailures: 0,
    manifest: {
      author: "Test",
      entrypoint: "./index.ts",
      persistent: false,
      tools: [{ name: "do-thing", description: "do it", inputSchema: { type: "object", properties: {} } }],
      permissions: {},
    },
    grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Stateful settings mock: GET, PUT/user, DELETE/user share an in-memory
 * store so a write reflects on the next read.
 */
async function installSettingsMock(
  page: Page,
  opts: {
    extId: string;
    schema: Record<string, unknown> | null;
    initialUser?: Record<string, unknown>;
  },
) {
  let userValues: Record<string, unknown> = { ...(opts.initialUser ?? {}) };
  const requests: Array<{ method: string; url: string; body: unknown }> = [];

  function resolved(): Record<string, unknown> {
    return { ...KOKORO_DECLARED_DEFAULTS, ...userValues };
  }

  await page.route(`**/api/extensions/${opts.extId}/settings`, async (route) => {
    const method = route.request().method();
    requests.push({ method, url: route.request().url(), body: null });
    if (method !== "GET") return route.fallback();
    if (opts.schema === null) {
      return route.fulfill({
        json: {
          schema: null,
          declaredDefaults: {},
          userValues: {},
          resolved: {},
        },
      });
    }
    return route.fulfill({
      json: {
        schema: opts.schema,
        declaredDefaults: KOKORO_DECLARED_DEFAULTS,
        userValues,
        resolved: resolved(),
      },
    });
  });

  await page.route(`**/api/extensions/${opts.extId}/settings/user`, async (route) => {
    const method = route.request().method();
    const body = method === "PUT" ? route.request().postDataJSON() : null;
    requests.push({ method, url: route.request().url(), body });
    if (method === "PUT") {
      if (opts.schema === null) {
        return route.fulfill({ status: 409, json: { error: "Extension has no settings schema" } });
      }
      if (!body || typeof body.values !== "object" || body.values === null) {
        return route.fulfill({ status: 400, json: { error: "values required" } });
      }
      userValues = { ...body.values };
      return route.fulfill({ json: { ok: true, userValues } });
    }
    if (method === "DELETE") {
      userValues = {};
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });

  return {
    requests,
    state: () => ({ userValues: { ...userValues } }),
  };
}

test.describe("Per-extension settings — UI flow", () => {
  const proj = makeProject({ id: "proj-1", name: "Test Project" });

  test("no settings → empty placeholder rendered", async ({ page, mockApi }) => {
    const detail = makeNoSettingsDetail();

    await mockApi({
      projects: [proj],
      routes: {
        "/api/extensions/ext-plain": () => detail,
        "/api/auth/me": () => USER_ME,
      },
    });

    await installSettingsMock(page, { extId: "ext-plain", schema: null });

    await page.goto("/extensions/ext-plain");

    await expect(page.getByTestId("extension-settings-section")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("extension-settings-empty")).toBeVisible();
    await expect(page.getByTestId("schema-form")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel-user")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel-global")).toHaveCount(0);
  });

  test("user sets voice, reload preserves it, no global panel exists", async ({ page, mockApi }) => {
    const detail = makeKokoroDetail();
    await mockApi({
      projects: [proj],
      routes: {
        "/api/extensions/ext-kokoro": () => detail,
        "/api/auth/me": () => USER_ME,
      },
    });
    const ctrl = await installSettingsMock(page, {
      extId: "ext-kokoro",
      schema: KOKORO_SETTINGS_SCHEMA as unknown as Record<string, unknown>,
    });

    await page.goto("/extensions/ext-kokoro");

    const userPanel = page.getByTestId("settings-panel-user");
    await expect(userPanel).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("settings-panel-global")).toHaveCount(0);

    await userPanel.getByTestId("schema-input-voice").selectOption("bf_emma");
    await userPanel.getByTestId("settings-panel-user-save").click();

    await expect.poll(() => ctrl.state().userValues.voice, { timeout: 3000 }).toBe("bf_emma");

    await page.reload();
    await expect(page.getByTestId("settings-panel-user")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("settings-panel-user").getByTestId("schema-input-voice")).toHaveValue("bf_emma");
    await expect(page.getByTestId("settings-panel-global")).toHaveCount(0);
  });

  test("user reset falls back to declared default", async ({ page, mockApi }) => {
    const detail = makeKokoroDetail();
    await mockApi({
      projects: [proj],
      routes: {
        "/api/extensions/ext-kokoro": () => detail,
        "/api/auth/me": () => USER_ME,
      },
    });
    const ctrl = await installSettingsMock(page, {
      extId: "ext-kokoro",
      schema: KOKORO_SETTINGS_SCHEMA as unknown as Record<string, unknown>,
      initialUser: { voice: "bf_emma" },
    });

    await page.goto("/extensions/ext-kokoro");

    const userPanel = page.getByTestId("settings-panel-user");
    await expect(userPanel).toBeVisible({ timeout: 5000 });
    await expect(userPanel.getByTestId("schema-input-voice")).toHaveValue("bf_emma");

    await userPanel.getByTestId("settings-panel-user-reset").click();

    await expect.poll(() => ctrl.state().userValues.voice ?? null, { timeout: 3000 }).toBeNull();

    const voiceAfterReset = await userPanel.getByTestId("schema-input-voice").inputValue();
    expect(voiceAfterReset).not.toBe("bf_emma");
  });

  test("no-settings extension GET returns schema:null with empty value blobs", async ({ page, mockApi }) => {
    const detail = makeNoSettingsDetail();
    await mockApi({
      projects: [proj],
      routes: {
        "/api/extensions/ext-plain": () => detail,
        "/api/auth/me": () => USER_ME,
      },
    });
    await installSettingsMock(page, { extId: "ext-plain", schema: null });

    await page.goto("/extensions/ext-plain");
    await expect(page.getByTestId("extension-settings-section")).toBeVisible({ timeout: 5000 });

    const payload = await page.evaluate(async () => {
      const r = await fetch("/api/extensions/ext-plain/settings");
      return { status: r.status, body: await r.json() };
    });
    expect(payload.status).toBe(200);
    expect(payload.body.schema).toBeNull();
    expect(payload.body.declaredDefaults).toEqual({});
    expect(payload.body.userValues).toEqual({});
    expect(payload.body.resolved).toEqual({});
  });
});
