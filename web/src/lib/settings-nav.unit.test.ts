/**
 * Unit tests for the settings hub registry + legacy-anchor redirect
 * (tasks/settings-ux-overhaul.md locked decision 2 — every historical
 * `/settings#<anchor>` deep link must map onto its new sub-route).
 */
import { describe, test, expect } from "vitest";
import {
  SETTINGS_NAV,
  SETTINGS_DEFAULT_ROUTE,
  settingsDefaultRoute,
  resolveLegacyHash,
  visibleNavItems,
  activeNavId,
} from "./settings-nav";

describe("resolveLegacyHash — full redirect table", () => {
  const modelAnchors = ["providers", "tier", "order", "custom-models"];
  for (const a of modelAnchors) {
    test(`#${a} → /settings/models#${a} for admins`, () => {
      expect(resolveLegacyHash(`#${a}`, true)).toBe(`/settings/models#${a}`);
    });
    // Models & Providers became admin-only: its reads and writes both
    // require the admin role, so a member deep-linking here must land
    // somewhere they can actually open.
    test(`#${a} → member default for non-admins (admin-gated)`, () => {
      expect(resolveLegacyHash(`#${a}`, false)).toBe(settingsDefaultRoute(false));
    });
  }

  const personalizationAnchors = [
    "instructions",
    "modes",
    "briefing",
    "audit-visibility",
    "advanced",
  ];
  for (const a of personalizationAnchors) {
    test(`#${a} → /settings/personalization#${a}`, () => {
      expect(resolveLegacyHash(`#${a}`, false)).toBe(`/settings/personalization#${a}`);
    });
  }

  for (const a of ["developer", "api-keys"]) {
    test(`#${a} → /settings/developer (no fragment)`, () => {
      expect(resolveLegacyHash(`#${a}`, false)).toBe("/settings/developer");
      expect(resolveLegacyHash(`#${a}`, true)).toBe("/settings/developer");
    });
  }

  const searchAnchors = ["search-backend", "search-defaults"];
  for (const a of searchAnchors) {
    test(`#${a} → /settings/search#${a} for admins`, () => {
      expect(resolveLegacyHash(`#${a}`, true)).toBe(`/settings/search#${a}`);
    });
    test(`#${a} → default route for non-admins (admin-gated)`, () => {
      expect(resolveLegacyHash(`#${a}`, false)).toBe(settingsDefaultRoute(false));
    });
  }

  const adminAnchors = ["users", "teams", "invites", "security", "health"];
  for (const a of adminAnchors) {
    test(`#${a} → /settings/admin#${a} for admins`, () => {
      expect(resolveLegacyHash(`#${a}`, true)).toBe(`/settings/admin#${a}`);
    });
    test(`#${a} → default route for non-admins`, () => {
      expect(resolveLegacyHash(`#${a}`, false)).toBe(settingsDefaultRoute(false));
    });
  }

  test("#audit → /settings/admin/audit for admins, default for members", () => {
    expect(resolveLegacyHash("#audit", true)).toBe("/settings/admin/audit");
    expect(resolveLegacyHash("#audit", false)).toBe(settingsDefaultRoute(false));
  });

  test("unknown hash → default route", () => {
    expect(resolveLegacyHash("#does-not-exist", true)).toBe(settingsDefaultRoute(true));
    expect(resolveLegacyHash("#does-not-exist", false)).toBe(settingsDefaultRoute(false));
  });

  test("empty / bare hash → default route", () => {
    expect(resolveLegacyHash("", false)).toBe(settingsDefaultRoute(false));
    expect(resolveLegacyHash("#", true)).toBe(settingsDefaultRoute(true));
  });

  test("accepts the anchor without a leading #", () => {
    expect(resolveLegacyHash("providers", true)).toBe("/settings/models#providers");
  });
});

describe("settingsDefaultRoute", () => {
  test("never returns a page that role cannot open — the redirect-loop guard", () => {
    // This is the whole point of deriving it. When Models & Providers turned
    // admin-only, a hardcoded `/settings/models` default sent members to a
    // page that immediately bounced them back to the same default, forever.
    for (const isAdmin of [true, false]) {
      const route = settingsDefaultRoute(isAdmin);
      const target = SETTINGS_NAV.find((i) => i.href === route);
      expect(target, `${route} must be a real nav entry`).toBeDefined();
      expect(target!.adminOnly && !isAdmin).toBe(false);
    }
  });

  test("SETTINGS_DEFAULT_ROUTE is the NON-ADMIN answer", () => {
    // Its callers have all already established the visitor is not an admin,
    // so it must never resolve to an admin-only page.
    expect(SETTINGS_DEFAULT_ROUTE).toBe(settingsDefaultRoute(false));
    const target = SETTINGS_NAV.find((i) => i.href === SETTINGS_DEFAULT_ROUTE);
    expect(target?.adminOnly).toBe(false);
  });

  test("admins land on Models & Providers, members on the first page they may open", () => {
    expect(settingsDefaultRoute(true)).toBe("/settings/models");
    expect(settingsDefaultRoute(false)).toBe("/settings/personalization");
  });

  test("resolveLegacyHash never sends a member to an admin-only page", () => {
    const adminHrefs = new Set(SETTINGS_NAV.filter((i) => i.adminOnly).map((i) => i.href));
    const everyAnchor = SETTINGS_NAV.flatMap((i) => [...i.anchors, ...(i.bareAnchors ?? [])]);
    for (const anchor of [...everyAnchor, "", "#", "unknown-anchor"]) {
      const dest = resolveLegacyHash(anchor, false).split("#")[0]!;
      expect(adminHrefs.has(dest), `member routed to admin-only ${dest} via "${anchor}"`).toBe(
        false,
      );
    }
  });
});

describe("visibleNavItems", () => {
  test("hides admin entries for members", () => {
    const ids = visibleNavItems(false).map((i) => i.id);
    expect(ids).toEqual(["personalization", "briefing", "developer"]);
  });

  test("shows admin entries for admins", () => {
    const ids = visibleNavItems(true).map((i) => i.id);
    expect(ids).toContain("admin");
    expect(ids).toContain("admin-audit");
    expect(ids).toContain("websearch");
  });

  test("hides the admin-only Search entry from members", () => {
    expect(visibleNavItems(false).map((i) => i.id)).not.toContain("websearch");
  });
});

describe("activeNavId", () => {
  test("exact match per route", () => {
    expect(activeNavId("/settings/models")).toBe("models");
    expect(activeNavId("/settings/personalization")).toBe("personalization");
    expect(activeNavId("/settings/developer")).toBe("developer");
    expect(activeNavId("/settings/admin")).toBe("admin");
    expect(activeNavId("/settings/briefing")).toBe("briefing");
    expect(activeNavId("/settings/search")).toBe("websearch");
  });

  test("nested audit page wins over the admin prefix", () => {
    expect(activeNavId("/settings/admin/audit")).toBe("admin-audit");
  });

  test("non-settings path → null", () => {
    expect(activeNavId("/agents")).toBeNull();
    expect(activeNavId("/settings")).toBeNull();
  });
});

describe("registry invariants", () => {
  test("every anchor is unique across the registry", () => {
    const all = SETTINGS_NAV.flatMap((i) => [...i.anchors, ...(i.bareAnchors ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });

  test("all hrefs live under /settings/ except the additive admin links", () => {
    // Settings v2 (locked decision 2) surfaces the canonical System and
    // Moderation pages as ADDITIVE links that point OUT of the hub.
    const externalAdminLinks = new Set(["/admin/dashboard", "/admin/moderation"]);
    for (const item of SETTINGS_NAV) {
      if (externalAdminLinks.has(item.href)) continue;
      expect(item.href.startsWith("/settings/")).toBe(true);
    }
  });
});

describe("Extension RBAC — Permissions entry", () => {
  test("registry includes the admin-gated Permissions sub-route", () => {
    const permissions = SETTINGS_NAV.find((i) => i.id === "permissions");
    expect(permissions).toMatchObject({
      label: "Permissions",
      href: "/settings/permissions",
      adminOnly: true,
    });
  });

  test("hidden from members, shown to admins (manager nav visibility is a follow-up)", () => {
    expect(visibleNavItems(false).map((i) => i.id)).not.toContain("permissions");
    expect(visibleNavItems(true).map((i) => i.id)).toContain("permissions");
  });

  test("active-state derives for /settings/permissions", () => {
    expect(activeNavId("/settings/permissions")).toBe("permissions");
  });
});

describe("Settings v2 — additive System/Moderation admin links", () => {
  test("registry includes System and Moderation, admin-gated, pointing to canonical routes", () => {
    const system = SETTINGS_NAV.find((i) => i.id === "system");
    const moderation = SETTINGS_NAV.find((i) => i.id === "moderation");

    expect(system).toMatchObject({ label: "System", href: "/admin/dashboard", adminOnly: true });
    expect(moderation).toMatchObject({
      label: "Moderation",
      href: "/admin/moderation",
      adminOnly: true,
    });
  });

  test("hidden from members, shown to admins", () => {
    const memberIds = visibleNavItems(false).map((i) => i.id);
    expect(memberIds).not.toContain("system");
    expect(memberIds).not.toContain("moderation");

    const adminIds = visibleNavItems(true).map((i) => i.id);
    expect(adminIds).toContain("system");
    expect(adminIds).toContain("moderation");
  });

  test("active-state derives for the canonical admin paths", () => {
    expect(activeNavId("/admin/dashboard")).toBe("system");
    expect(activeNavId("/admin/moderation")).toBe("moderation");
    // Adding them must not steal the settings-admin active state.
    expect(activeNavId("/settings/admin")).toBe("admin");
  });
});
