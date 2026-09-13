import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";

type Fixture = { success: Array<{ name: string; kind: "request" | "result"; value: unknown }>; rejected: Array<{ name: string; kind: "request" | "result"; path: Array<string | number>; value: unknown }> };
const root = join(import.meta.dir, "../../..");
const fixture = JSON.parse(await readFile(join(import.meta.dir, "fixtures/c02-conformance.json"), "utf8")) as Fixture;
const coverageDirectory = await mkdtemp(join(tmpdir(), "factory-python-coverage-"));
const coverageData = process.env.EZ_FACTORY_PYTHON_COVERAGE_DATA ?? join(coverageDirectory, ".coverage");
const coverageReport = process.env.EZ_FACTORY_PYTHON_COVERAGE_REPORT ?? join(coverageDirectory, "coverage.json");

afterAll(async () => { await rm(coverageDirectory, { recursive: true, force: true }); });

function copy(value: unknown): any { return JSON.parse(JSON.stringify(value)); }
function set(value: any, path: Array<string | number>, replacement: unknown): void {
  let target = value;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)!] = replacement;
}
function sdk(kind: "request" | "result", value: unknown) {
  return kind === "request" ? validateFactoryRunnerRequest(value) : validateFactoryRunnerResult(value);
}

async function python(kind: "request" | "result", value: unknown) {
  const child = Bun.spawn({
    cmd: ["nix", "shell", "nixpkgs#uv", "-c", "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"), "coverage", "run", "--branch", "--append", "--data-file", coverageData, join(import.meta.dir, "python/c02_runner.py"), "--request-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-request.schema.json"), "--result-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-result.schema.json"), "--sdk-bridge", join(import.meta.dir, "canonical-validator.mjs")],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ kind, value }));
  child.stdin.end();
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, output: JSON.parse(output) as { ok: boolean; schemaId?: string; error?: string } };
}

test("C02 golden fixtures accept identically through Bun SDK, Node bridge, and a real Python process", async () => {
  for (const item of fixture.success) {
    expect(sdk(item.kind, item.value)).toEqual({ ok: true });
    const result = await python(item.kind, item.value);
    expect(result.exitCode).toBe(0);
    expect(result.output.ok).toBe(true);
  }
});

test("C02 golden rejections reject forged pins, unsafe counters, money, schemas, usage, and checkpoints everywhere", async () => {
  for (const item of fixture.rejected) {
    const base = copy(fixture.success.find(success => success.kind === item.kind)!.value);
    set(base, item.path, item.value);
    expect(sdk(item.kind, base).ok).toBe(false);
    const result = await python(item.kind, base);
    expect(result.exitCode).toBe(1);
    expect(result.output.ok).toBe(false);
  }
});

test("real Python child writes branch coverage for the canonical C02 runner", async () => {
  const child = Bun.spawn(["nix", "shell", "nixpkgs#uv", "-c", "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"), "coverage", "json", "--data-file", coverageData, "-o", coverageReport], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  const report = JSON.parse(await readFile(coverageReport, "utf8")) as { files: Record<string, { executed_lines: number[] }> };
  const entry = Object.entries(report.files).find(([file]) => file.endsWith("c02_runner.py"));
  expect(entry).toBeDefined();
  expect(entry![1].executed_lines.length).toBeGreaterThan(0);
});
