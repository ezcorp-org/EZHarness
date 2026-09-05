import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command, digest, executionLimits, filesDigest, identifier, limitsWithin, relativePath, RunnerError, sha256, validateFiles } from "../src/core";

test("workspace and command inputs reject path and resource escapes", () => {
  expect(relativePath("nested/file.ts")).toBe("nested/file.ts");
  for (const path of ["", "/host", "../host", "a/../b", "a\\b", "a//b", "a\0b", "C:file", "a".repeat(1025)]) expect(() => relativePath(path)).toThrow();
  expect(identifier("host-issued_id-1")).toBe("host-issued_id-1");
  for (const id of ["--privileged", "../a", "a b", ""]) expect(() => identifier(id)).toThrow();
  expect(digest("a".repeat(64))).toBe("a".repeat(64));
  expect(() => digest("a".repeat(63))).toThrow();
  expect(limitsWithin(executionLimits, executionLimits)).toEqual(executionLimits);
  expect(() => limitsWithin({ ...executionLimits, memoryBytes: executionLimits.memoryBytes + 1 }, executionLimits)).toThrow();
  expect(() => limitsWithin({ ...executionLimits, timeoutMs: 0 }, executionLimits)).toThrow();
  expect(() => validateFiles({ "a.ts": "abc" }, 2)).toThrow("bytes");
  expect(() => validateFiles({ "a.ts": "a", "b.ts": "b" }, 20, 1)).toThrow("files");
  expect(() => validateFiles([] as unknown as Record<string, string>)).toThrow();
  expect(() => validateFiles({ "a.ts": 1 } as unknown as Record<string, string>)).toThrow();
  expect(filesDigest({ b: "2", a: "1" })).toBe(filesDigest({ a: "1", b: "2" }));
  expect(filesDigest({ "2": "two", "10": "ten" })).toBe(sha256('{"10":"ten","2":"two"}'));
  expect(new RunnerError("denied", "Denied", "build", true).diagnostic()).toEqual({ code: "denied", message: "Denied", stage: "build", retryable: true });
});

test("control processes bound stdout, stderr and elapsed time", async () => {
  expect(await command(process.execPath, ["-e", "console.log('ok')"])).toBe("ok\n");
  await expect(command(process.execPath, ["-e", "console.error('failure');process.exit(1)"])).rejects.toThrow("failure");
  await expect(command(process.execPath, ["-e", "console.log('failure');process.exit(1)"])).rejects.toThrow("failure");
  await expect(command(process.execPath, ["-e", "process.exit(1)"])).rejects.toThrow("exited 1");
  await expect(command("/missing/control", [])).rejects.toThrow();
  await expect(command(process.execPath, ["-e", "setInterval(()=>{},1000)"], 20)).rejects.toThrow("timed out");
  await expect(command(process.execPath, ["-e", "console.log('x'.repeat(1000))"], 1000, 20)).rejects.toThrow("output");
});

test("separate Bun boots read current environment from the same large module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-runtime-env-"));
  try {
    const modulePath = join(directory, "environment.mjs");
    await writeFile(modulePath, `export const padding=${JSON.stringify("x".repeat(100000))}; export const value=process.env.EZ_TEST_RUNTIME_TOKEN;`);
    for (const token of ["first-process-secret", "second-process-secret"]) {
      const child = Bun.spawn([process.execPath, "-e", `const module=await import(${JSON.stringify(modulePath)});console.log(module.value);`], { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", EZ_TEST_RUNTIME_TOKEN: token }, stdout: "pipe", stderr: "pipe" });
      expect((await new Response(child.stdout).text()).trim()).toBe(token);
      expect(await child.exited).toBe(0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
