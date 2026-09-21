import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFactoryGuestModelRequest, validateFactoryGuestModelResponse, validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { loadFactoryConformanceFixtures, type FactoryConformanceKind } from "../../__tests__/helpers/factory-c02-conformance-fixtures";

/**
 * Host-Python C02 conformance: the narrow lane.
 *
 * This runs the committed `c02_runner.py` as a real child process on the host
 * interpreter and compares its verdict with the Bun validator's, fixture by
 * fixture. It is deliberately narrower than
 * `python-guest.integration.test.ts`, which runs the same validator inside the
 * digest-pinned isolated guest; the plan asks for both, and keeping this one
 * separate means a Python regression is caught without waiting on Podman.
 *
 * It used to compare three parties, because the Python side had no validator of
 * its own and shelled out to a Node bridge for the semantics. C07 rejects a
 * validator that works in only one runtime, so the bridge is gone and there are
 * two parties left. The comparison is stronger for it: the two runtimes are now
 * checked for the same issue code, not merely for the same yes or no.
 */

type Verdict = { ok: boolean; schemaId?: string; runtime?: string; code?: string; path?: Array<string | number>; error?: string };

const root = join(import.meta.dir, "../../..");
const fixture = await loadFactoryConformanceFixtures(join(import.meta.dir, "fixtures"));
const SCHEMA_IDS: Record<FactoryConformanceKind, string> = {
  request: "urn:ezcorp:factory:runner-request:v1",
  result: "urn:ezcorp:factory:runner-result:v1",
  "guest-model-request": "urn:ezcorp:factory:guest-model-request:v1",
  "guest-model-response": "urn:ezcorp:factory:guest-model-response:v1",
};
const coverageDirectory = await mkdtemp(join(tmpdir(), "factory-python-coverage-"));
const coverageData = process.env.EZ_FACTORY_PYTHON_COVERAGE_DATA ?? join(coverageDirectory, ".coverage");
const coverageReport = process.env.EZ_FACTORY_PYTHON_COVERAGE_REPORT ?? join(coverageDirectory, "coverage.json");

afterAll(async () => { await rm(coverageDirectory, { recursive: true, force: true }); });

function sdk(kind: FactoryConformanceKind, value: unknown) {
  if (kind === "request") return validateFactoryRunnerRequest(value);
  if (kind === "result") return validateFactoryRunnerResult(value);
  if (kind === "guest-model-request") return validateFactoryGuestModelRequest(value);
  return validateFactoryGuestModelResponse(value);
}
function sdkCode(result: ReturnType<typeof sdk>): string | undefined {
  return (result as unknown as { issues?: Array<{ code: string }> }).issues?.[0]?.code;
}

async function python(kind: FactoryConformanceKind, value: unknown) {
  const child = Bun.spawn({
    cmd: [
      "nix", "shell", "nixpkgs#uv", "-c",
      "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"),
      "coverage", "run", "--branch", "--append", "--data-file", coverageData,
      join(import.meta.dir, "python/c02_runner.py"),
      "--request-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-request.schema.json"),
      "--result-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-result.schema.json"),
      "--guest-model-request-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-guest-model-request.schema.json"),
      "--guest-model-response-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-guest-model-response.schema.json"),
    ],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ kind, value }));
  child.stdin.end();
  const [exitCode, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (!output.trim()) throw new Error(`host Python produced no verdict (exit ${exitCode}): ${errors.trim()}`);
  return { exitCode, output: JSON.parse(output) as Verdict };
}

test("C02 golden fixtures accept identically through the Bun SDK and a real host Python process", async () => {
  for (const item of fixture.success) {
    expect(sdk(item.kind, item.value)).toEqual({ ok: true });
    const result = await python(item.kind, item.value);
    expect(result.exitCode).toBe(0);
    expect(result.output.ok).toBe(true);
    expect(result.output.runtime).toBe("factory.python-guest.v1");
    expect(result.output.schemaId).toBe(SCHEMA_IDS[item.kind]);
  }
});

test("C02 golden rejections refuse forged pins, unsafe counters, money, schemas, usage, and checkpoints with the same issue code in both runtimes", async () => {
  for (const item of fixture.rejected) {
    const bun = sdk(item.kind, item.value);
    expect(bun.ok, `${item.name} was accepted by the Bun validator`).toBe(false);
    const result = await python(item.kind, item.value);
    expect(result.exitCode).toBe(1);
    expect(result.output.ok).toBe(false);
    // The bridge is gone, so this is the whole point of the comparison: the two
    // runtimes must refuse for the same stated reason, not merely both refuse.
    expect(result.output.code).toBe(sdkCode(bun));
    expect(result.output.error).toBe(sdkCode(bun));
  }
});

test("a malformed envelope is refused by the host entry point rather than crashing it", async () => {
  const child = Bun.spawn({
    cmd: [
      "nix", "shell", "nixpkgs#uv", "-c",
      "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"),
      "coverage", "run", "--branch", "--append", "--data-file", coverageData,
      join(import.meta.dir, "python/c02_runner.py"),
      "--request-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-request.schema.json"),
      "--result-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-result.schema.json"),
    ],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ kind: "checkpoint", value: {} }));
  child.stdin.end();
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(1);
  expect(JSON.parse(output)).toEqual({ ok: false, error: "envelope must contain kind and value" });
});

test("real Python child writes branch coverage for the canonical C02 runner", async () => {
  const child = Bun.spawn(["nix", "shell", "nixpkgs#uv", "-c", "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"), "coverage", "json", "--data-file", coverageData, "-o", coverageReport], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const report = JSON.parse(await readFile(coverageReport, "utf8")) as { files: Record<string, { executed_lines: number[] }> };
  const entry = Object.entries(report.files).find(([file]) => file.endsWith("c02_runner.py"));
  expect(entry).toBeDefined();
  expect(entry![1].executed_lines.length).toBeGreaterThan(0);
});
