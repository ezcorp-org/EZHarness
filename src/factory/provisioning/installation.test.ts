import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertFactoryFleetId,
  assertFactoryInstallationRequest,
  factoryFleetResourceName,
  factoryInstallationNames,
  type FactoryInstallationRequest,
} from "./installation";
import { FactoryProvisioningError } from "./steps";

const valid: FactoryInstallationRequest = { tenantId: "tenant-07", hostname: "tenant-07.factory.example", administratorEmail: "Admin@Example.com" };

function codeOf(work: () => unknown): string {
  try { work(); }
  catch (error) {
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    return (error as FactoryProvisioningError).code;
  }
  return "no-error";
}

describe("assertFactoryInstallationRequest", () => {
  test("accepts a generated tenant, a DNS hostname, and an email", () => {
    expect(codeOf(() => assertFactoryInstallationRequest(valid))).toBe("no-error");
    expect(codeOf(() => assertFactoryInstallationRequest({ ...valid, hostname: "a" }))).toBe("no-error");
    expect(codeOf(() => assertFactoryInstallationRequest({ ...valid, hostname: `${"a".repeat(63)}.example` }))).toBe("no-error");
  });

  test("refuses a tenant that is not tenant-XX", () => {
    for (const tenantId of ["tenant-7", "tenant-007", "Tenant-07", "tenant-ab", "", "tenant-07 "]) {
      expect(codeOf(() => assertFactoryInstallationRequest({ ...valid, tenantId }))).toBe("provisioning_request_invalid");
    }
  });

  test("refuses malformed hostnames", () => {
    for (const hostname of ["", "UPPER.example", "-lead.example", "trail-.example", "a..b", `${"a".repeat(64)}.example`, "has space.example", `${"a.".repeat(127)}ab`]) {
      expect(codeOf(() => assertFactoryInstallationRequest({ ...valid, hostname }))).toBe("provisioning_request_invalid");
    }
  });

  test("refuses malformed emails", () => {
    for (const administratorEmail of ["", "no-at.example", "a@b", "a b@example.com", "a@@example.com", `${"a".repeat(65)}@example.com`]) {
      expect(codeOf(() => assertFactoryInstallationRequest({ ...valid, administratorEmail }))).toBe("provisioning_request_invalid");
    }
  });
});

describe("assertFactoryFleetId", () => {
  test("accepts lowercase DNS labels of 2 to 32 characters", () => {
    for (const fleetId of ["ab", "fleet-1", `a${"b".repeat(31)}`]) expect(codeOf(() => assertFactoryFleetId(fleetId))).toBe("no-error");
  });

  test("refuses anything else with provisioning_fleet_invalid", () => {
    for (const fleetId of ["a", "", "1fleet", "fleet-", "Fleet", "fleet_1", `a${"b".repeat(32)}`]) expect(codeOf(() => assertFactoryFleetId(fleetId))).toBe("provisioning_fleet_invalid");
  });
});

describe("factoryFleetResourceName", () => {
  test("is the prefix plus 20 hex characters of sha256(fleet NUL tenant)", () => {
    const expected = createHash("sha256").update("fleet-a\u0000tenant-01").digest("hex").slice(0, 20);
    expect(factoryFleetResourceName("factory_product", "fleet-a", "tenant-01")).toBe(`factory_product_${expected}`);
  });

  test("is deterministic and scoped by both fleet and tenant", () => {
    const base = factoryFleetResourceName("p", "fleet-a", "tenant-01");
    expect(factoryFleetResourceName("p", "fleet-a", "tenant-01")).toBe(base);
    expect(factoryFleetResourceName("p", "fleet-b", "tenant-01")).not.toBe(base);
    expect(factoryFleetResourceName("p", "fleet-a", "tenant-02")).not.toBe(base);
    // The NUL separator stops a concatenation collision between fleet and tenant.
    expect(factoryFleetResourceName("p", "fleet-at", "enant-01")).not.toBe(base);
  });
});

describe("factoryInstallationNames", () => {
  test("derives every name from fleet and tenant and resolves both roots", () => {
    const names = factoryInstallationNames("fleet-a", "tenant-01", { secretsRoot: "/srv/secrets/", operatorRoot: "/srv/operator/../operator" });
    expect(names).toEqual({
      productDatabase: factoryFleetResourceName("factory_product", "fleet-a", "tenant-01"),
      productRole: factoryFleetResourceName("factory_role", "fleet-a", "tenant-01"),
      temporalNamespace: "tenant-01.fleet-a",
      secretDirectory: "/srv/secrets/tenant-01",
      operatorDirectory: "/srv/operator/tenant-01",
    });
    expect(Object.isFrozen(names)).toBe(true);
    expect(names.productDatabase).not.toBe(names.productRole);
  });

  test("refuses an invalid fleet before deriving any name", () => {
    expect(codeOf(() => factoryInstallationNames("BAD", "tenant-01", { secretsRoot: "/a", operatorRoot: "/b" }))).toBe("provisioning_fleet_invalid");
  });
});
