import { describe, expect, test } from "bun:test";
import type { MigrationDb } from "../db/migrations/types";
import { factoryTenantAdministratorRefusalInTransaction, isActiveFactoryAdministrator } from "./tenant-administrator";

/** A transaction whose one read returns the given user rows. */
const transaction = (users: readonly unknown[]) => ({ execute: async () => ({ rows: users }) }) as unknown as MigrationDb;
const session = { kind: "user" as const, id: "admin-1", authentication: "session" as const };

describe("the tenant administrator rule", () => {
  test("only an admin whose status is exactly active qualifies; NULL, unknown, or missing fails closed", () => {
    expect(isActiveFactoryAdministrator({ role: "admin", status: "active" })).toBe(true);
    expect(isActiveFactoryAdministrator({ role: "admin", status: null })).toBe(false);
    expect(isActiveFactoryAdministrator({ role: "admin", status: "inactive" })).toBe(false);
    expect(isActiveFactoryAdministrator({ role: "user", status: "active" })).toBe(false);
    expect(isActiveFactoryAdministrator({ role: null, status: "active" })).toBe(false);
    expect(isActiveFactoryAdministrator(undefined)).toBe(false);
  });

  test("a key, a service, or a non-administrator is refused by name; an active administrator session passes", async () => {
    expect(await factoryTenantAdministratorRefusalInTransaction(transaction([]), { ...session, authentication: "api-key" })).toBe("factory_human_required");
    expect(await factoryTenantAdministratorRefusalInTransaction(transaction([]), { kind: "service", id: "s", authentication: "service" })).toBe("factory_human_required");
    expect(await factoryTenantAdministratorRefusalInTransaction(transaction([{ role: "admin", status: null }]), session)).toBe("factory_forbidden");
    expect(await factoryTenantAdministratorRefusalInTransaction(transaction([]), session)).toBe("factory_forbidden");
    expect(await factoryTenantAdministratorRefusalInTransaction(transaction([{ role: "admin", status: "active" }]), session)).toBeNull();
  });
});
