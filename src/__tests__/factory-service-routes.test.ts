import { describe, expect, test } from "bun:test";
import { buildFactoryServiceRoutePolicy, factoryServiceRouteScope, isRegisteredFactoryRoute } from "../auth/factory-service-routes";

describe("factory service route policy", () => {
  test("derives exact Svelte route IDs, methods and service scopes", () => {
    const route = "/api/factories/projects/[projectId]/definitions/[factoryId]";
    expect(factoryServiceRouteScope("GET", route)).toBe("read");
    expect(factoryServiceRouteScope("PUT", route)).toBe("write");
    expect(factoryServiceRouteScope("POST", route)).toBeNull();
    expect(isRegisteredFactoryRoute("GET", route)).toBe(true);
    // C01 assigns version publish the `write` scope (requirement-index
    // discrepancy 10), so a write-scoped service credential holding the
    // project `factory.publish` grant reaches it. This assertion used to read
    // `toBeNull()` against the older session-only behaviour; the widening is
    // deliberate and is recorded in the W09 gate file.
    expect(factoryServiceRouteScope("POST", "/api/factories/projects/[projectId]/definitions/[factoryId]/versions")).toBe("write");
    // The other half of the same discrepancy tightens: grant management is
    // `admin`, which is not a factory service scope at all, so no service
    // credential can reach it however it is scoped.
    const grant = "/api/factories/projects/[projectId]/grants/[principalKind]/[principalId]/[action]";
    expect(factoryServiceRouteScope("PUT", grant)).toBeNull();
    expect(factoryServiceRouteScope("DELETE", grant)).toBeNull();
    expect(isRegisteredFactoryRoute("PUT", grant)).toBe(true);
    expect(factoryServiceRouteScope("GET", undefined)).toBeNull();
  });

  test("fails closed for an unavailable registry and rejects duplicate policies", () => {
    expect(buildFactoryServiceRoutePolicy(undefined).size).toBe(0);
    const entry = { method: "GET" as const, path: "/api/factories/projects/:projectId/definitions", description: "read", category: "factories", scope: "read" as const };
    expect(() => buildFactoryServiceRoutePolicy([entry, entry])).toThrow("Duplicate factory route policy");
    expect(buildFactoryServiceRoutePolicy([{ ...entry, category: "other" }]).size).toBe(0);
  });
});
