/**
 * Phase B — CLI `ext verify` parsing/shape/exit code + `runExtensionTests`
 * smokeTest fold-in.
 *
 * - `parseArgs(["ext","verify",dir,"--json"])` ⇒ `{command:"ext:verify",
 *   extDir, json:true}`.
 * - `cli(["ext","verify",dir,"--json"])` prints VerifyResult JSON and
 *   exits 0 on pass / 1 on fail.
 * - `runExtensionTests`: bun-test-pass + smoke-pass ⇒ 0; bun-test-pass
 *   + smoke-fail ⇒ non-zero.
 */

import {
  test,
  expect,
  describe,
  afterAll,
  mock,
  spyOn,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

const { parseArgs, cli } = await import("../cli");
const { buildVerifyFixture } = await import("./helpers/verify-fixtures");
const { runExtensionTests } = await import("../extensions/sdk/test-runner");

describe("parseArgs — ext verify", () => {
  test("ext verify <dir> ⇒ command + extDir, json:false", () => {
    const r = parseArgs(["ext", "verify", "/tmp/x"]);
    expect(r.command).toBe("ext:verify");
    expect(r.extDir).toBe("/tmp/x");
    expect(r.json).toBe(false);
  });

  test("ext verify <dir> --json ⇒ json:true", () => {
    const r = parseArgs(["ext", "verify", "/tmp/x", "--json"]);
    expect(r.command).toBe("ext:verify");
    expect(r.json).toBe(true);
  });
});

describe("cli — ext verify --json", () => {
  test("passing fixture ⇒ prints VerifyResult JSON, exit 0", async () => {
    const fx = buildVerifyFixture({ name: "cli-verify-pass" });
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(
        cli(["ext", "verify", fx.dir, "--json"]),
      ).rejects.toThrow("exit:0");
      const out = logs.join("\n");
      const parsed = JSON.parse(out);
      expect(parsed.pass).toBe(true);
      expect(Array.isArray(parsed.steps)).toBe(true);
      expect(parsed.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fx.cleanup();
    }
  }, 20_000);

  test("failing fixture (missing smokeTest) ⇒ exit 1", async () => {
    const fx = buildVerifyFixture({ name: "cli-verify-fail", smokeTest: null });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(
        cli(["ext", "verify", fx.dir, "--json"]),
      ).rejects.toThrow("exit:1");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fx.cleanup();
    }
  }, 20_000);

  test("non-json mode prints human steps + verdict", async () => {
    const fx = buildVerifyFixture({ name: "cli-verify-human" });
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(cli(["ext", "verify", fx.dir])).rejects.toThrow("exit:0");
      const out = logs.join("\n");
      expect(out).toContain("VERIFY: PASS");
      expect(out).toContain("smoke-test-roundtrip");
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fx.cleanup();
    }
  }, 20_000);
});

describe("runExtensionTests — smokeTest fold-in", () => {
  test("bun-test-pass + smoke-pass ⇒ exit 0", async () => {
    const fx = buildVerifyFixture({ name: "foldin-pass" });
    // Add a trivially-passing bun test alongside the fixture.
    await Bun.write(
      `${fx.dir}/index.test.ts`,
      `import { test, expect } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n`,
    );
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runExtensionTests({ extDir: fx.dir });
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
      fx.cleanup();
    }
  }, 30_000);

  test("bun-test-pass + smoke-fail ⇒ non-zero exit", async () => {
    const fx = buildVerifyFixture({
      name: "foldin-fail",
      pingErrors: true,
      smokeTest: {
        tool: "ping",
        input: { message: "x" },
        expect: { isError: false },
      },
    });
    await Bun.write(
      `${fx.dir}/index.test.ts`,
      `import { test, expect } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n`,
    );
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runExtensionTests({ extDir: fx.dir });
      expect(code).not.toBe(0);
    } finally {
      logSpy.mockRestore();
      fx.cleanup();
    }
  }, 30_000);

  test("bun-test-FAIL short-circuits before smoke (non-zero)", async () => {
    const fx = buildVerifyFixture({ name: "foldin-buntest-fail" });
    await Bun.write(
      `${fx.dir}/index.test.ts`,
      `import { test, expect } from "bun:test";\ntest("boom", () => expect(1).toBe(2));\n`,
    );
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runExtensionTests({ extDir: fx.dir });
      expect(code).not.toBe(0);
    } finally {
      logSpy.mockRestore();
      fx.cleanup();
    }
  }, 30_000);
});
