import { afterEach, describe, expect, test } from "bun:test";
import { referenceCodeV1, referenceImageV1, type FactoryDefinition } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { FactoryGrants } from "./grants";
import { configureFactoryApplication, createFactoryApplication, definitionAvailability, draftAvailability, getFactoryApplication } from "./application";

const database = {} as TransactionalDb;
const blobs = {} as BlobStore;

afterEach(() => configureFactoryApplication(null));

describe("factory application composition", () => {
  test("copies trusted resource inventory and configures one frozen application", () => {
    const inventory = new Set(["cpu"]);
    const application = createFactoryApplication({ database, tenantId: "tenant-1", blobs, availableResourceClasses: inventory });
    inventory.add("gpu");
    expect(application.availableResourceClasses.has("cpu")).toBe(true);
    expect(application.availableResourceClasses.has("gpu")).toBe(false);
    expect(Object.isFrozen(application)).toBe(true);
    expect(application.definitions.tenantId).toBe("tenant-1");
    expect(application.grants.tenantId).toBe("tenant-1");
    expect(getFactoryApplication()).toBeNull();
    configureFactoryApplication(application);
    expect(getFactoryApplication()).toBe(application);
  });

  test("rejects invalid identity and mismatched grant scope", () => {
    expect(() => createFactoryApplication({ database, tenantId: "", blobs, availableResourceClasses: [] })).toThrow();
    expect(() => createFactoryApplication({ database, tenantId: "tenant-1", blobs, availableResourceClasses: [""] })).toThrow();
    const grants = new FactoryGrants(database, "tenant-2");
    expect(() => createFactoryApplication({ database, tenantId: "tenant-1", blobs, grants, availableResourceClasses: [] })).toThrow("factory_scope_mismatch");
  });

  test("finds deep resource requirements and fails closed on invalid semantics", () => {
    expect(definitionAvailability(referenceImageV1, new Set())).toEqual({ availability: "unavailable", availabilityReason: "Unavailable resource classes: gpu." });
    expect(definitionAvailability(referenceImageV1, new Set(["gpu"]))).toEqual({ availability: "available" });
    expect(definitionAvailability(referenceCodeV1, new Set())).toEqual({ availability: "available" });
    const invalid = {
      ...referenceCodeV1,
      graph: {
        ...referenceCodeV1.graph,
        nodes: referenceCodeV1.graph.nodes.map((node, index) => index === 0 ? { ...node, dependsOn: ["missing"] } : node),
      },
    } as FactoryDefinition;
    expect(definitionAvailability(invalid, new Set())).toEqual({ availability: "unavailable", availabilityReason: "Definition validation failed with 1 diagnostic." });
    expect(draftAvailability({ requiredResourceClasses: [], requirementsComplete: false, validationDiagnosticCount: 0 }, new Set())).toEqual({ availability: "unavailable", availabilityReason: "Definition resource requirements exceed supported limits." });
  });
});
