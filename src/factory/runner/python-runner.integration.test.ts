import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";

type Fixture = { success: Array<{ name: string; kind: "request" | "result"; value: unknown }>; rejected: Array<{ name: string; kind: "request" | "result"; path: Array<string | number>; value: unknown }> };
const root = join(import.meta.dir, "../../..");
const fixture = JSON.parse(await readFile(join(import.meta.dir, "fixtures/c02-conformance.json"), "utf8")) as Fixture;

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
    cmd: ["nix", "shell", "nixpkgs#uv", "-c", "uv", "run", "--frozen", "--project", join(import.meta.dir, "python"), "python", join(import.meta.dir, "python/c02_runner.py"), "--request-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-request.schema.json"), "--result-schema", join(root, "packages/@ezcorp/factory-sdk/src/factory-runner-result.schema.json"), "--sdk-bridge", join(import.meta.dir, "canonical-validator.mjs")],
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
