import { test, expect, describe } from "bun:test";

const FILES_TO_CHECK = [
  "web/src/routes/api/auth/login/+server.ts",
  "web/src/routes/api/auth/setup/+server.ts",
  "web/src/routes/api/auth/logout/+server.ts",
  "web/src/routes/api/auth/invite/[token]/+server.ts",
  "web/src/routes/(auth)/login/+page.server.ts",
  "web/src/routes/(auth)/signup/[token]/+page.server.ts",
];

describe("cookie rename: pi_session -> ezcorp_session", () => {
  for (const filePath of FILES_TO_CHECK) {
    test(`${filePath} uses ezcorp_session (directly or via setSessionCookie helper) and not pi_session`, async () => {
      const content = await Bun.file(filePath).text();
      // Files either reference the cookie name literally OR route through
      // the `setSessionCookie` helper (web/src/lib/server/auth/session-cookie.ts)
      // which owns the cookie name. Helper-routed files no longer contain
      // the literal "ezcorp_session" but still produce the same Set-Cookie.
      const usesCookieDirectly = content.includes("ezcorp_session");
      const usesHelper = content.includes("setSessionCookie");
      expect(usesCookieDirectly || usesHelper).toBe(true);
      expect(content).not.toContain("pi_session");
    });
  }

  test("setSessionCookie helper sources the ezcorp_session name", async () => {
    const content = await Bun.file("web/src/lib/server/auth/session-cookie.ts").text();
    expect(content).toContain("ezcorp_session");
    expect(content).not.toContain("pi_session");
  });

  test("hooks.server.ts has migration bridge referencing both cookies", async () => {
    const content = await Bun.file("web/src/hooks.server.ts").text();
    expect(content).toContain("ezcorp_session");
    // Migration bridge should reference pi_session for backward compat
    expect(content).toContain("pi_session");
    // Should delete old cookie
    expect(content).toContain("maxAge: 0");
  });
});
