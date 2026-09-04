import { describe, expect, test } from "bun:test";
import { clampExtensionPermissions } from "../clamp-permissions";
import { buildFullGrantFromManifest } from "../install-grant";
import type { ExtensionManifestV2 } from "../types";

describe("host API permission grants", () => {
  test("intersects exact route and event IDs without wildcard escalation", () => {
    const grant = clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }, { method: "POST", path: "/api/admin" }, { method: "GET", path: "/api/*" }], events: true } }, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } });
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: false });
    expect(clampExtensionPermissions({}, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }).hostApi).toBeUndefined();
    expect(clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }, {}).hostApi).toBeUndefined();
  });

  test("full exact-release grants retain and timestamp host API permissions", () => {
    const manifest: ExtensionManifestV2 = { schemaVersion: 3, name: "fixture", version: "1.0.0", description: "Test", author: { name: "Test" }, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: true } } };
    const grant = buildFullGrantFromManifest(manifest, 12_345);
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: true });
    expect(grant.grantedAt.hostApi).toBe(12_345);
  });
});
