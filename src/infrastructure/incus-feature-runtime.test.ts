import { expect, mock, test } from "bun:test";
const database = {};
const evidence = {};
let qualificationDb: unknown;
let readinessArguments: unknown[] = [];
let options: { admissionReadiness: unknown; loadQualification: (scope: unknown) => Promise<unknown> };
let loadedScope: unknown;
mock.module("../db/connection", () => ({ getDb: () => database }));
mock.module("./incus-qualification", () => ({ IncusQualificationStore: class {
  constructor(input: { db: unknown }) { qualificationDb = input.db; }
  async load(scope: unknown) { loadedScope = scope; return evidence; }
} }));
mock.module("./incus-admission-readiness", () => ({ IncusAdmissionReadinessService: class {
  constructor(...args: unknown[]) { readinessArguments = args; }
} }));
mock.module("./incus-feature-service", () => ({ IncusFeatureService: class {
  constructor(input: typeof options) { options = input; }
} }));
const { configuredIncusFeatureService } = await import("./incus-feature-runtime");
test("both lifecycle consumers use the same database, readiness, and qualification factory", async () => {
  expect(configuredIncusFeatureService()).toBeDefined();
  expect(qualificationDb).toBe(database);
  expect(readinessArguments[0]).toBe(database);
  expect(readinessArguments[1]).toBeDefined();
  expect(options!.admissionReadiness).toBeDefined();
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" };
  expect(await options!.loadQualification(scope)).toBe(evidence);
  expect(loadedScope).toBe(scope);
});
