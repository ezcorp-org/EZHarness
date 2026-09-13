import { describe, expect, test } from "bun:test";
import { buildFactoryServiceRoutePolicy, factoryServiceRouteScope, isRegisteredFactoryRoute } from "../auth/factory-service-routes";

describe("factory service route policy", () => {
  test("derives exact Svelte route IDs, methods and service scopes", () => {
    const route = "/api/factories/projects/[projectId]/definitions/[factoryId]";
    expect(factoryServiceRouteScope("GET", route)).toBe("read");
    expect(factoryServiceRouteScope("PUT", route)).toBe("write");
    expect(factoryServiceRouteScope("POST", route)).toBeNull();
    expect(isRegisteredFactoryRoute("GET", route)).toBe(true);
    expect(factoryServiceRouteScope("POST", "/api/factories/projects/[projectId]/definitions/[factoryId]/versions")).toBeNull();
    expect(factoryServiceRouteScope("GET", undefined)).toBeNull();
  });

  test("fails closed for an unavailable registry and rejects duplicate policies", () => {
    expect(buildFactoryServiceRoutePolicy(undefined).size).toBe(0);
    const entry = { method: "GET" as const, path: "/api/factories/projects/:projectId/definitions", description: "read", category: "factories", scope: "read" as const };
    expect(() => buildFactoryServiceRoutePolicy([entry, entry])).toThrow("Duplicate factory route policy");
    expect(buildFactoryServiceRoutePolicy([{ ...entry, category: "other" }]).size).toBe(0);
  });
});
