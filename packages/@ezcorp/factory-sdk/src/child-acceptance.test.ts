import { expect, test } from "bun:test";
import {
  assertFactoryChildAcceptanceResult,
  factoryChildAcceptancePortSchema,
  factoryChildAcceptanceResult,
  FactoryChildAcceptanceError,
  FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
} from "./child-acceptance";
import { referenceCatalogV1 } from "./references";
import type { JsonValue } from "./types";
import { validateValue } from "./validation";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const artifact: JsonValue = { digest: digest("a"), mediaType: "application/json", storage: "immutable://accepted" };
const input = {
  decisionId: "decision-1",
  contractDigest: digest("c"),
  candidateDigest: digest("d"),
  evidenceSetDigest: digest("e"),
  artifact,
};

test("the built result carries the decision that accepted the bytes", () => {
  expect(factoryChildAcceptanceResult(input)).toEqual({
    schemaVersion: FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
    releaseMode: "none",
    decisionId: "decision-1",
    contractDigest: digest("c"),
    candidateDigest: digest("d"),
    evidenceSetDigest: digest("e"),
    artifact,
  });
  expect(FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION).toBe("factory.child-acceptance.v1");
});

test("every field the decision proves is required, and a malformed digest is refused", () => {
  const valid = factoryChildAcceptanceResult(input);
  const cases: Record<string, unknown> = {
    "a null value": null,
    "an array": [],
    "a string": "accepted",
    "a wrong schema version": { ...valid, schemaVersion: "factory.child-acceptance.v2" },
    "an authorized release mode": { ...valid, releaseMode: "authorized" },
    "an empty decision id": { ...valid, decisionId: "" },
    "a non-string decision id": { ...valid, decisionId: 7 },
    "a bare-hex contract digest": { ...valid, contractDigest: "c".repeat(64) },
    "a short candidate digest": { ...valid, candidateDigest: "sha256:abc" },
    "an upper-case evidence digest": { ...valid, evidenceSetDigest: `sha256:${"C".repeat(64)}` },
    "a right-length digest with a non-hex character": { ...valid, contractDigest: `sha256:${"z".repeat(64)}` },
    "a right-length string with the wrong prefix": { ...valid, contractDigest: `sha257:${"a".repeat(64)}` },
    "a non-string digest": { ...valid, candidateDigest: 71 },
  };
  for (const [label, value] of Object.entries(cases)) {
    expect(() => assertFactoryChildAcceptanceResult(value), label).toThrow(FactoryChildAcceptanceError);
  }
  const missingArtifact: Record<string, unknown> = { ...valid };
  delete missingArtifact.artifact;
  expect(() => assertFactoryChildAcceptanceResult(missingArtifact)).toThrow(FactoryChildAcceptanceError);
  expect(new FactoryChildAcceptanceError("factory_child_acceptance_invalid").code).toBe("factory_child_acceptance_invalid");
});

test("an extra field is dropped rather than carried into the sealed value", () => {
  const widened = { ...factoryChildAcceptanceResult(input), smuggled: "operation-1" };
  expect(assertFactoryChildAcceptanceResult(widened)).toEqual(factoryChildAcceptanceResult(input));
});

test("the port schema admits the real value and refuses a publishing child's receipt", () => {
  const value = factoryChildAcceptanceResult(input) as unknown as JsonValue;
  expect(validateValue(factoryChildAcceptancePortSchema, value).ok).toBe(true);

  const providerReceipt: JsonValue = { provider: "s3", bucket: "accepted", manifestKey: "operation/manifest.json", confirmed: true };
  const authorized: JsonValue = { ...(value as Record<string, JsonValue>), releaseMode: "authorized" };
  const unaddressable: JsonValue = { ...(value as Record<string, JsonValue>), artifact: { storage: "immutable://accepted" } };
  for (const refused of [providerReceipt, authorized, unaddressable]) {
    expect(validateValue(factoryChildAcceptancePortSchema, refused).ok).toBe(false);
  }
});

test("every acceptance-only child in the catalog declares THIS schema, not a copy of it", () => {
  const children = referenceCatalogV1.graph.nodes.filter(node => node.kind === "subfactory");
  expect(children.map(node => node.id)).toEqual(["accepted-data", "accepted-image", "static-catalog-code"]);
  for (const child of children) {
    // Identity, not equality: a second declaration that happened to match today
    // is exactly the drift this module exists to prevent.
    expect(child.outputPorts?.receipt, child.id).toBe(factoryChildAcceptancePortSchema);
    expect(child.kind === "subfactory" && child.releaseMode, child.id).toBe("none");
    expect(child.kind === "subfactory" && child.grants, child.id).toEqual([]);
  }
});
