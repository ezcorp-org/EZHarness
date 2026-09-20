import { expect, test } from "bun:test";
import { referenceCatalogV1, validateValue, type JsonValue, type PortSchema } from "@ezcorp/factory-sdk";
import {
  assertFactoryChildAcceptanceResult,
  factoryChildAcceptanceDigest,
  factoryChildAcceptanceResult,
  FactoryChildReleaseModeError,
  FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
  narrowerFactoryReleaseMode,
  type FactoryInheritedReleaseMode,
} from "./child-release-mode";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const artifact: JsonValue = { digest: digest("a"), mediaType: "application/json", storage: "immutable://accepted" };

const input = {
  decisionId: "decision-1",
  contractDigest: digest("c"),
  candidateDigest: digest("d"),
  evidenceSetDigest: digest("e"),
  artifact,
};

/** The port every acceptance-only child in `reference.catalog.v1` must satisfy. */
function catalogChildPort(nodeId: string): PortSchema {
  const node = referenceCatalogV1.graph.nodes.find(candidate => candidate.id === nodeId);
  if (node?.kind !== "subfactory") throw new Error(`${nodeId} is not a subfactory node`);
  const port = node.outputPorts?.receipt;
  if (!port) throw new Error(`${nodeId} declares no receipt port`);
  return port;
}

test("`none` narrows every combination, and two roots stay root", () => {
  const modes: FactoryInheritedReleaseMode[] = ["root", "authorized", "none"];
  for (const left of modes) {
    for (const right of modes) {
      const expected = left === "none" || right === "none" ? "none" : left === "authorized" || right === "authorized" ? "authorized" : "root";
      expect(narrowerFactoryReleaseMode(left, right)).toBe(expected);
    }
  }
});

test("the built result carries the decision that accepted the bytes, and is stable", () => {
  const result = factoryChildAcceptanceResult(input);
  expect(result).toEqual({
    schemaVersion: FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
    releaseMode: "none",
    decisionId: "decision-1",
    contractDigest: digest("c"),
    candidateDigest: digest("d"),
    evidenceSetDigest: digest("e"),
    artifact,
  });
  expect(factoryChildAcceptanceDigest(result)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(factoryChildAcceptanceDigest(result)).toBe(factoryChildAcceptanceDigest(factoryChildAcceptanceResult(input)));
  expect(factoryChildAcceptanceDigest(result)).not.toBe(factoryChildAcceptanceDigest(factoryChildAcceptanceResult({ ...input, decisionId: "decision-2" })));
});

test("every field the decision proves is required, and a malformed digest is refused", () => {
  const cases: Record<string, unknown> = {
    "a null value": null,
    "an array": [],
    "a string": "accepted",
    "a wrong schema version": { ...factoryChildAcceptanceResult(input), schemaVersion: "factory.child-acceptance.v2" },
    "an authorized release mode": { ...factoryChildAcceptanceResult(input), releaseMode: "authorized" },
    "an empty decision id": { ...factoryChildAcceptanceResult(input), decisionId: "" },
    "a non-string decision id": { ...factoryChildAcceptanceResult(input), decisionId: 7 },
    "a bare-hex contract digest": { ...factoryChildAcceptanceResult(input), contractDigest: "c".repeat(64) },
    "a short candidate digest": { ...factoryChildAcceptanceResult(input), candidateDigest: "sha256:abc" },
    "an upper-case evidence digest": { ...factoryChildAcceptanceResult(input), evidenceSetDigest: `sha256:${"C".repeat(64)}` },
  };
  for (const [label, value] of Object.entries(cases)) {
    expect(() => assertFactoryChildAcceptanceResult(value), label).toThrow(FactoryChildReleaseModeError);
  }
  const missingArtifact: Record<string, unknown> = { ...factoryChildAcceptanceResult(input) };
  delete missingArtifact.artifact;
  expect(() => assertFactoryChildAcceptanceResult(missingArtifact)).toThrow(FactoryChildReleaseModeError);
  expect(new FactoryChildReleaseModeError("factory_child_release_mode_invalid").code).toBe("factory_child_release_mode_invalid");
});

test("an extra field is dropped rather than carried into the sealed value", () => {
  const widened = { ...factoryChildAcceptanceResult(input), smuggled: "operation-1" };
  expect(assertFactoryChildAcceptanceResult(widened)).toEqual(factoryChildAcceptanceResult(input));
});

test("the real value satisfies the port every catalog child declares", () => {
  const result = factoryChildAcceptanceResult(input) as unknown as JsonValue;
  for (const nodeId of ["accepted-data", "accepted-image", "static-catalog-code"]) {
    expect(validateValue(catalogChildPort(nodeId), result).ok, nodeId).toBe(true);
  }
});

test("a publishing child's provider receipt can never satisfy that port", () => {
  const providerReceipt: JsonValue = { provider: "s3", bucket: "accepted", manifestKey: "operation/manifest.json", confirmed: true };
  const authorizedRelease: JsonValue = { ...(factoryChildAcceptanceResult(input) as unknown as Record<string, JsonValue>), releaseMode: "authorized" };
  for (const nodeId of ["accepted-data", "accepted-image", "static-catalog-code"]) {
    expect(validateValue(catalogChildPort(nodeId), providerReceipt).ok, `${nodeId} provider receipt`).toBe(false);
    expect(validateValue(catalogChildPort(nodeId), authorizedRelease).ok, `${nodeId} authorized release`).toBe(false);
  }
});

test("every catalog child is composed in acceptance-only mode and widens no parent authority", () => {
  const children = referenceCatalogV1.graph.nodes.filter(node => node.kind === "subfactory");
  expect(children.map(node => node.id)).toEqual(["accepted-data", "accepted-image", "static-catalog-code"]);
  for (const child of children) {
    expect(child.kind === "subfactory" && child.releaseMode, child.id).toBe("none");
    expect(child.kind === "subfactory" && child.grants, child.id).toEqual([]);
  }
});
