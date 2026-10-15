import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FACTORY_VALIDATOR_RUNTIME_SCHEMA, FactoryValidatorDeclarationError, loadFactoryValidatorRuntimes, MAX_VALIDATOR_MATERIAL_BYTES } from "./validator-declaration";
import type { FactoryStartupValidatorRuntime } from "./startup-config";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const root = await makeFactoryTempPrivateRoot("w09d-validators-");
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

const sha256 = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const runner = { package: "@ezcorp/validator", manifestName: "validator", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run", configurationDigest: `sha256:${"c".repeat(64)}` };
const material = {
  schemaVersion: FACTORY_VALIDATOR_RUNTIME_SCHEMA, kind: "podman-guest", runner,
  resources: { resourceClass: "cpu", memoryBytes: 64, maxComputeMs: 4 },
  brokerAudience: "factory-gateway", environmentDigest: `sha256:${"e".repeat(64)}`, configurationDigest: runner.configurationDigest, maxEvidenceAgeMs: 60_000,
};

/** Write one material file and the declaration that names it by its own digest. */
async function declared(content: unknown, options: { readonly mode?: number; readonly digestOf?: string } = {}): Promise<FactoryStartupValidatorRuntime> {
  const root = await privateRoot();
  const path = join(root, "validator.json");
  const bytes = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, options.mode ?? 0o600);
  return { name: "claim-runtime", kind: "podman-guest", runner, materialPath: path, materialDigest: sha256(options.digestOf ?? bytes) };
}

async function refusal(runtime: FactoryStartupValidatorRuntime): Promise<FactoryValidatorDeclarationError> {
  const error = await loadFactoryValidatorRuntimes({ validators: { runtimes: [runtime] } }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FactoryValidatorDeclarationError);
  return error as FactoryValidatorDeclarationError;
}

describe("the declared validator runtimes", () => {
  test("nothing declared is no runtime, not an error", async () => {
    expect(await loadFactoryValidatorRuntimes({})).toBeUndefined();
  });

  test("an exact declaration becomes W05's runtime shape, with the document's name", async () => {
    const loaded = await loadFactoryValidatorRuntimes({ validators: { runtimes: [await declared(material)] } });
    const { schemaVersion: _schemaVersion, kind: _kind, ...runtime } = material;
    expect(loaded).toEqual([{ name: "claim-runtime", runtime }]);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test("a runtime that pins a model keeps it", async () => {
    const model = { provider: "provider", model: "model", configuration: {}, configurationDigest: runner.configurationDigest, policy: {}, policyDigest: `sha256:${"f".repeat(64)}` };
    const [loaded] = (await loadFactoryValidatorRuntimes({ validators: { runtimes: [await declared({ ...material, model })] } }))!;
    expect(loaded!.runtime.model).toEqual(model as never);
  });

  test("a missing, shared, or oversized file refuses as unreadable, naming the runtime and never its bytes", async () => {
    const missing = { ...(await declared(material)), materialPath: join(await privateRoot(), "absent.json") };
    const shared = await declared(material, { mode: 0o644 });
    const oversized = await declared("x".repeat(MAX_VALIDATOR_MATERIAL_BYTES + 1));
    for (const runtime of [missing, shared, oversized]) {
      const error = await refusal(runtime);
      expect(error.code).toBe("factory_validator_declaration_unreadable");
      expect(error.runtime).toBe("claim-runtime");
      expect(error.message).not.toContain("factory-gateway");
    }
  });

  test("bytes that are not the declared ones refuse before any field is believed", async () => {
    const error = await refusal(await declared(material, { digestOf: JSON.stringify({ ...material, maxEvidenceAgeMs: 1 }) }));
    expect(error.code).toBe("factory_validator_declaration_digest_mismatch");
    expect(error.message).toBe("factory_validator_declaration_digest_mismatch: claim-runtime: its material file does not have the declared digest");
  });

  test("the declared bytes must describe this runtime, runner, and kind", async () => {
    const { brokerAudience: _dropped, ...missingKey } = material;
    const cases: unknown[] = [
      "not json {",
      [],
      missingKey,
      { ...material, extra: true },
      { ...material, schemaVersion: "factory.validator-runtime.v0" },
      { ...material, runner: "runner" },
      { ...material, resources: null },
      { ...material, model: "model" },
      { ...material, runner: { ...runner, export: "other" } },
      { ...material, kind: "native" },
    ];
    for (const content of cases) {
      expect((await refusal(await declared(content))).code).toBe("factory_validator_declaration_invalid");
    }
  });

  test("the first refusal among several runtimes names that runtime", async () => {
    const good = await declared(material);
    const bad = { ...(await declared(material, { digestOf: "other" })), name: "second-runtime" };
    const error = await loadFactoryValidatorRuntimes({ validators: { runtimes: [good, bad] } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "factory_validator_declaration_digest_mismatch", runtime: "second-runtime" });
  });
});
