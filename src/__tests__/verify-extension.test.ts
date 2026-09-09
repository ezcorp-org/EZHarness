import { describe, expect, test } from "bun:test";
import { verifyExtension } from "../extensions/sdk/verify";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { runStorageMigration, verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";
import { release } from "./helpers/lifecycle-policy-fixture";
import { buildVerifyFixture } from "./helpers/verify-fixtures";

test("legacy verification refuses a valid-looking local package without execution", async () => {
  const fixture = buildVerifyFixture({});
  const marker = `${fixture.dir}/executed`;
  const original = await Bun.file(`${fixture.dir}/ezcorp.config.ts`).text();
  await Bun.write(`${fixture.dir}/ezcorp.config.ts`, `await Bun.write(${JSON.stringify(marker)}, "executed");\n${original}`);
  try {
    const result = await verifyExtension({ extDir: fixture.dir });
    expect(result.pass).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ name: "load-manifest", ok: false });
    expect(result.steps[0]!.detail).toMatch(/workspace.*build.*inspect.*human approval/);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { fixture.cleanup(); }
});

test("legacy verification refuses missing source rather than claiming acceptance", async () => {
  expect((await verifyExtension({ extDir: "/missing-extension" })).pass).toBe(false);
});

test("missing legacy verification source has no successful verification step", async () => {
  const result = await verifyExtension({ extDir: "/missing-extension" });
  expect(result.pass).toBe(false);
  expect(result.steps).toEqual([expect.objectContaining({ name: "load-manifest", ok: false })]);
  expect(result.steps[0]?.detail).toMatch(/workspace.*build.*inspect.*human approval/);
});

// Current v4 candidate verification replaces the retired local verifier.
function candidateRunner(request: RunnerExecution["request"]): { runner: Runner; closed: () => boolean; contexts: unknown[] } {
  let closed = false;
  const contexts: unknown[] = [];
  const runner: Runner = {
    async build() { throw new Error("not used"); }, async cancel() {}, async inspect() { return { id: "worker", state: "running", diagnostics: [] }; }, async collectArtifacts() { return {}; },
    async start(input) {
      contexts.push(input.context);
      return { workerId: input.workerId, request, async close() { closed = true; }, onNotification() { return () => {}; } };
    },
  };
  return { runner, closed: () => closed, contexts };
}

describe("candidate verification", () => {
  test("storage migration binds identity, denies effects, validates output and closes its worker", async () => {
    const candidate = structuredClone(release);
    candidate.manifest.methods = [{ name: "migrate", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["values"] } }];
    const input = { release: candidate, method: "migrate", principalId: "owner", scope: "private", fromVersion: "1", toVersion: "2", values: { note: "retained" } };
    const calls: unknown[] = [];
    const fixture = candidateRunner(async (method, payload) => { calls.push({ method, payload }); return { values: input.values }; });
    const originalStart = fixture.runner.start;
    fixture.runner.start = async (request, reverse) => {
      await expect(reverse("ezcorp/storage.set", { context: request.context })).rejects.toMatchObject({ code: "migration_effect_denied" });
      return originalStart(request, reverse);
    };
    expect(await runStorageMigration(fixture.runner, input)).toEqual({ values: input.values });
    expect(fixture.contexts[0]).toMatchObject({ principalId: "owner", scopeId: "data-migration:private" });
    expect(calls[0]).toMatchObject({ method: "extension/dispatch", payload: { method: "migrate", input: { fromVersion: "1", toVersion: "2", values: input.values } } });
    expect(fixture.closed()).toBe(true);
    await expect(runStorageMigration(fixture.runner, { ...input, method: "undeclared" })).rejects.toMatchObject({ code: "migration_method_missing" });
    const invalid = candidateRunner(async () => ({}));
    await expect(runStorageMigration(invalid.runner, input)).rejects.toThrow();
    expect(invalid.closed()).toBe(true);
  });
  test("smoke error status assertions check both expected outcomes", async () => {
    for (const expected of [true, false]) {
      const candidate = structuredClone(release);
      candidate.manifest.tools![0]!.outputSchema = { type: "object" };
      candidate.manifest.smokeTest!.expect = { isError: expected };
      for (const actual of [true, false, undefined]) {
        const fixture = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : actual === undefined ? {} : { isError: actual });
        if ((actual === true) === expected) expect((await verifyExtensionCandidate(fixture.runner, candidate)).smoke).toBe("passed");
        else await expect(verifyExtensionCandidate(fixture.runner, candidate)).rejects.toMatchObject({ code: "smoke_assertion_failed" });
        expect(fixture.closed()).toBe(true);
      }
    }
  });
  test("text assertions inspect literal tool text rather than JSON-escaped transport", async () => {
    const candidate = structuredClone(release);
    candidate.manifest.tools![0]!.outputSchema = { type: "object" };
    candidate.manifest.smokeTest!.expect = { textIncludes: '"ok": true' };
    const fixture = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : { content: [{ type: "text", text: '{\n  "ok": true\n}' }] });
    expect((await verifyExtensionCandidate(fixture.runner, candidate)).smoke).toBe("passed");
    const invalid = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : { content: [{ type: "image", text: '"ok": true' }] });
    await expect(verifyExtensionCandidate(invalid.runner, candidate)).rejects.toMatchObject({ code: "smoke_assertion_failed" });
  });
  test("checks runtime metadata and output using a separate verification identity", async () => {
    const fixture = candidateRunner(async (method) => method === "extension/discover" ? release.manifest : { text: "hello" });
    await verifyExtensionCandidate(fixture.runner, release);
    expect(fixture.closed()).toBe(true);
    expect(fixture.contexts[0]).toMatchObject({ principalId: "extension-verification", releaseId: release.id });
  });

  test("changed catalog and schema-invalid output fail and close the worker", async () => {
    const changed = candidateRunner(async () => ({ ...release.manifest, version: "2.0.0" }));
    await expect(verifyExtensionCandidate(changed.runner, release)).rejects.toMatchObject({ code: "runtime_catalog_mismatch" });
    expect(changed.closed()).toBe(true);
    const malformed = candidateRunner(async (method) => method === "extension/discover" ? release.manifest : { text: 123 });
    await expect(verifyExtensionCandidate(malformed.runner, release)).rejects.toThrow();
    expect(malformed.closed()).toBe(true);
  });

  test("sealed catalogs do not invent an undeclared smoke invocation", async () => {
    const manifest = structuredClone(release.manifest);
    delete manifest.smokeTest;
    const methods: string[] = [];
    const fixture = candidateRunner(async (method) => { methods.push(method); return manifest; });
    await verifyExtensionCandidate(fixture.runner, { ...release, manifest });
    expect(methods).toEqual(["extension/discover"]);
    expect(fixture.closed()).toBe(true);
  });
});
