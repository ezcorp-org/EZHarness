import { describe, expect, test } from "bun:test";
import { canonicalizeJson, sha256Hex } from "./canonical";
import {
  referenceCodeDefinition,
  referenceCodeModelPin,
  referenceCodeV1,
  referenceFactoryModelPin,
  referenceImageV1,
  referenceModelConfiguration,
  referenceModelPolicy,
  referenceS3ReleaseAdapter,
} from "./references";
import type { FactoryDefinition, FactoryNode, JsonValue, RunnerReference } from "./types";

const digestOf = (value: JsonValue): string => `sha256:${sha256Hex(canonicalizeJson(value))}`;
const PLACEHOLDER = /^sha256:([0-9a-f])\1{63}$/;

type Task = Extract<FactoryNode, { kind: "task" }>;
const taskRunner = (definition: FactoryDefinition, exported: string): RunnerReference =>
  (definition.graph.nodes.find((node): node is Task => node.kind === "task" && node.runner.export === exported) as Task).runner;
const claimValidators = (definition: FactoryDefinition, exported: string): RunnerReference[] =>
  definition.acceptance.claims.map(claim => claim.validator).filter(validator => validator.export === exported);
const releaseNode = (definition: FactoryDefinition) => definition.graph.nodes.find(node => node.kind === "release") as Extract<FactoryNode, { kind: "release" }>;

describe("the reference model pin is a real configuration (W4H-28 P4)", () => {
  test("the pin's digests are the digests of its own configuration and policy", () => {
    expect(referenceCodeModelPin).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      configuration: referenceModelConfiguration,
      configurationDigest: digestOf(referenceModelConfiguration),
      policy: referenceModelPolicy,
      policyDigest: digestOf(referenceModelPolicy),
    });
    expect(referenceCodeModelPin.configurationDigest).not.toMatch(PLACEHOLDER);
  });

  test("generateCandidate and supervisedReview name the pin's model and configuration digest", () => {
    for (const runner of [taskRunner(referenceCodeV1, "generateCandidate"), ...claimValidators(referenceCodeV1, "supervisedReview")]) {
      expect(runner.model).toBe(referenceCodeModelPin.model);
      expect(runner.configurationDigest).toBe(referenceCodeModelPin.configurationDigest);
    }
  });

  test("protectedChecks calls no model, so neither its task nor its nine claims name one", () => {
    const runners = [taskRunner(referenceCodeV1, "protectedChecks"), ...claimValidators(referenceCodeV1, "protectedChecks")];
    expect(runners).toHaveLength(10);
    for (const runner of runners) expect(runner.model).toBeUndefined();
  });
});

describe("referenceCodeDefinition builds one graph with two parameters", () => {
  test("its defaults are reference.code.v1 exactly", () => {
    expect(referenceCodeDefinition()).toEqual(referenceCodeV1);
  });

  test("another model pin changes the two model runners and nothing else", () => {
    const mock = referenceFactoryModelPin("ezcorp-mock", "mock:w4h28");
    const built = referenceCodeDefinition({ model: mock });
    for (const runner of [taskRunner(built, "generateCandidate"), ...claimValidators(built, "supervisedReview")]) {
      expect(runner).toMatchObject({ model: "mock:w4h28", configurationDigest: mock.configurationDigest });
    }
    const strip = (definition: FactoryDefinition) => JSON.parse(JSON.stringify(definition).replaceAll('"mock:w4h28"', '"gpt-6-luna"'));
    expect(strip(built)).toEqual(JSON.parse(JSON.stringify(referenceCodeV1)));
  });

  test("the S3 release destination is a parameter: the release adapter changes, the inputs do not", () => {
    const built = referenceCodeDefinition({ release: "s3" });
    expect(releaseNode(built).adapter).toEqual(referenceS3ReleaseAdapter);
    expect(releaseNode(built).destination).toEqual(releaseNode(referenceCodeV1).destination);
    expect(built.inputPorts).toEqual(referenceCodeV1.inputPorts);
    expect(built.packages.map(item => item.name)).toContain(referenceS3ReleaseAdapter.package);
    expect(built.packages.map(item => item.name)).not.toContain(releaseNode(referenceCodeV1).adapter.package);
  });
});

describe("the reference S3 release adapter is a published artifact, not a placeholder", () => {
  test("no reference definition names the S3 adapter with a placeholder digest", () => {
    expect(referenceS3ReleaseAdapter.digest).not.toMatch(PLACEHOLDER);
    expect(releaseNode(referenceImageV1).adapter).toEqual(referenceS3ReleaseAdapter);
  });
});
