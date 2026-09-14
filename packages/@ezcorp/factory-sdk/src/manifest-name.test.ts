import { describe, expect, test } from "bun:test";
// Imported from the package barrel on purpose: the migration note in freeze
// section 17 tells W10, W11 and W12 to call this, and a helper they cannot
// import from `@ezcorp/factory-sdk` is a note they cannot follow.
import { isManifestName, manifestNameOf, referenceFactories } from "@ezcorp/factory-sdk";
import type { RunnerReference } from "@ezcorp/factory-sdk";

describe("the v4 manifest name a scoped distribution corresponds to", () => {
  test("a scoped package name yields its unscoped manifest name", () => {
    expect(manifestNameOf("@ezcorp/reference-data")).toBe("reference-data");
    expect(manifestNameOf("@ezcorp/reference-code-validator")).toBe("reference-code-validator");
    expect(manifestNameOf("reference-image")).toBe("reference-image");
  });

  test("every derived name is one the v4 grammar admits, including from names it would refuse", () => {
    for (const scoped of ["@ezcorp/reference-data", "@Scope/Mixed_Case", "@x/9-leading-digit", "UPPER", "with spaces", "@scope/-leading-dash"]) {
      const derived = manifestNameOf(scoped);
      expect(isManifestName(derived)).toBe(true);
    }
  });

  test("a name that normalises away still yields a usable manifest name", () => {
    expect(manifestNameOf("")).toBe("runner");
    expect(manifestNameOf("@scope/")).toBe("runner");
    expect(manifestNameOf("___")).toBe("runner");
    expect(isManifestName(manifestNameOf(""))).toBe(true);
  });

  test("the derivation is bounded to the grammar's sixty-four characters", () => {
    const derived = manifestNameOf(`@ezcorp/${"a".repeat(200)}`);
    expect(derived).toHaveLength(64);
    expect(isManifestName(derived)).toBe(true);
  });

  test("the shipped reference factories already name a manifest the grammar admits", () => {
    const references: RunnerReference[] = [];
    for (const factory of Object.values(referenceFactories)) {
      for (const node of factory.graph.nodes) if (node.kind === "task") references.push(node.runner);
    }
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(isManifestName(reference.manifestName)).toBe(true);
      // The scoped identity keeps its own field and is not a legal manifest name.
      if (reference.package.includes("/")) expect(isManifestName(reference.package)).toBe(false);
      expect(reference.manifestName).toBe(manifestNameOf(reference.package));
    }
  });
});
