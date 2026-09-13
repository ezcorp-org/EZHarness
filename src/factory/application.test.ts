import { afterEach, describe, expect, test } from "bun:test";
import { referenceCodeV1, referenceImageV1, type FactoryDefinition } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { FactoryGrants } from "./grants";
import { configureFactoryApplication, createFactoryApplication, definitionAvailability, draftAvailability, getFactoryApplication } from "./application";

const database = {} as TransactionalDb;
const blobs = {} as BlobStore;
const runOptions = { interpreterBuild: "immutable-build", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) };

afterEach(() => configureFactoryApplication(null));

describe("factory application composition", () => {
  test("copies trusted resource inventory and configures one frozen application", () => {
    const inventory = new Set(["cpu"]);
    const application = createFactoryApplication({ database, tenantId: "tenant-1", blobs, runOptions, availableResourceClasses: inventory });
    inventory.add("gpu");
    expect(application.availableResourceClasses.has("cpu")).toBe(true);
    expect(application.availableResourceClasses.has("gpu")).toBe(false);
    expect(application.availableResourceClasses.size).toBe(1);
    expect([...application.availableResourceClasses]).toEqual(["cpu"]);
    expect([...application.availableResourceClasses.entries()]).toEqual([["cpu", "cpu"]]);
    expect([...application.availableResourceClasses.keys()]).toEqual(["cpu"]);
    expect([...application.availableResourceClasses.values()]).toEqual(["cpu"]);
    const visited: string[] = [];
    application.availableResourceClasses.forEach(function(this: string[], value, key, set) {
      expect(this).toBe(visited);
      expect(key).toBe(value);
      expect(set).toBe(application.availableResourceClasses);
      this.push(value);
    }, visited);
    expect(visited).toEqual(["cpu"]);
    expect([...application.availableResourceClasses.union(new Set(["gpu"]))]).toEqual(["cpu", "gpu"]);
    expect([...application.availableResourceClasses.intersection(new Set(["cpu", "gpu"]))]).toEqual(["cpu"]);
    expect([...application.availableResourceClasses.difference(new Set(["cpu"]))]).toEqual([]);
    expect([...application.availableResourceClasses.symmetricDifference(new Set(["gpu"]))]).toEqual(["cpu", "gpu"]);
    expect(application.availableResourceClasses.isSubsetOf(new Set(["cpu", "gpu"]))).toBe(true);
    expect(application.availableResourceClasses.isSupersetOf(new Set(["cpu"]))).toBe(true);
    expect(application.availableResourceClasses.isDisjointFrom(new Set(["gpu"]))).toBe(true);
    expect((application.availableResourceClasses as Set<string>).add).toBeUndefined();
    expect(Object.isFrozen(application)).toBe(true);
    expect(application.runs.tenantId).toBe("tenant-1");
    expect(application.definitions.tenantId).toBe("tenant-1");
    expect(application.grants.tenantId).toBe("tenant-1");
    expect(getFactoryApplication()).toBeNull();
    configureFactoryApplication(application);
    expect(getFactoryApplication()).toBe(application);
  });

  test("rejects invalid identity and mismatched grant scope", () => {
    expect(() => createFactoryApplication({ database, tenantId: "", blobs, runOptions, availableResourceClasses: [] })).toThrow();
    expect(() => createFactoryApplication({ database, tenantId: "tenant-1", blobs, runOptions, availableResourceClasses: [""] })).toThrow();
    const grants = new FactoryGrants(database, "tenant-2");
    expect(() => createFactoryApplication({ database, tenantId: "tenant-1", blobs, grants, runOptions, availableResourceClasses: [] })).toThrow("factory_scope_mismatch");
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
