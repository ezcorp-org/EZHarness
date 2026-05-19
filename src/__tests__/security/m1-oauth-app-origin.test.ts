// Regression test for sec-M1: GET /api/auth/oauth must validate the
// `app_origin` query parameter. Pre-fix the handler accepted any value
// and wove it into the appCallbackUrl passed to the callback subprocess,
// which later issued a 302 Location: redirect into that origin.
//
// Exploit narrative:
//   1. Attacker phishes a logged-in admin into visiting
//      GET /api/auth/oauth?provider=google&app_origin=https://evil.tld
//   2. The initiator started the local callback subprocess with
//      appCallbackUrl = "https://evil.tld/auth/callback".
//   3. Admin completes OAuth at Google; Google redirects to the local
//      callback; local callback issues 302 to https://evil.tld/auth/callback
//      carrying the OAuth code + state. PKCE protects the access token
//      itself, but the redirect is still an attacker-controlled open
//      redirect against a trusted local origin.
//
// Fix (dcda842):
//   - parse app_origin via new URL(); accept only if .origin === url.origin
//   - silently fall back to url.origin (with console.warn) otherwise
//   - empty, missing, javascript:, and cross-origin values all fall back
//
// Strategy: handler-level probe. Mock startOAuthCallbackServer to capture
// the appCallbackUrl argument. Drive the GET handler with every payload
// variant and assert the captured arg always begins with url.origin.
//
// Tests fix(sec-M1): dcda842

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  ADMIN_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler import) ───────────────────
mockServerAlias();

// SvelteKit generated $types stub.
mock.module("../../../web/src/routes/api/auth/oauth/$types", () => ({}));

// updated for sec-M2: the initiator now writes a pending OAuth record via
// upsertSetting (keyed by state). Mock the settings module so we don't
// touch a real DB — this test only asserts app_origin handling.
const settingsStore: Record<string, unknown> = {};
const settingsMock = () => ({
  getSetting: async (key: string) => settingsStore[key],
  upsertSetting: async (key: string, value: unknown) => {
    settingsStore[key] = value;
  },
  deleteSetting: async (key: string) => {
    const existed = key in settingsStore;
    delete settingsStore[key];
    return existed;
  },
  getAllSettings: async () => ({ ...settingsStore }),
  isListingInstalled: async () => false,
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

// Capture the appCallbackUrl passed into startOAuthCallbackServer.
const callbackCalls: Array<{ port: number; appCallbackUrl: string }> = [];
const callbackServerMock = () => ({
  startOAuthCallbackServer: (port: number, appCallbackUrl: string) => {
    callbackCalls.push({ port, appCallbackUrl });
  },
});
mock.module("$server/auth/oauth-callback-server", callbackServerMock);
mock.module("../../auth/oauth-callback-server", callbackServerMock);

// $lib alias for oauth-config
mock.module("$lib/server/oauth-config", () =>
  require("../../../web/src/lib/server/oauth-config"),
);

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { GET as oauthGet } from "../../../web/src/routes/api/auth/oauth/+server";

const BASE = "http://localhost:1455";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  callbackCalls.length = 0;
});

describe("sec-M1: GET /api/auth/oauth app_origin validation", () => {
  test("matching app_origin is passed through verbatim", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google&app_origin=${encodeURIComponent(BASE)}`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
  });

  test("cross-origin app_origin (https://evil.tld) is ignored — downstream sees url.origin", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google&app_origin=${encodeURIComponent("https://evil.tld")}`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    // Pre-fix this would have been "https://evil.tld/auth/callback" — the
    // attacker's chosen open-redirect target.
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
    expect(callbackCalls[0]!.appCallbackUrl).not.toContain("evil.tld");
  });

  test("missing app_origin falls back to url.origin", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
  });

  test("empty app_origin= falls back to url.origin", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google&app_origin=`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
  });

  test("unparseable app_origin (javascript: URL) is rejected → url.origin", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google&app_origin=${encodeURIComponent("javascript:alert(1)")}`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
    expect(callbackCalls[0]!.appCallbackUrl).not.toContain("javascript");
  });

  test("app_origin with attacker path is still rejected when origin differs", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google&app_origin=${encodeURIComponent("https://evil.tld:1455")}`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    expect(callbackCalls.length).toBe(1);
    expect(callbackCalls[0]!.appCallbackUrl).toBe(`${BASE}/auth/callback`);
  });
});
