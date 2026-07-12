/**
 * ExtensionProcess npm-dependency contract + crash-surfacing coverage
 * (src/extensions/subprocess.ts, feature: extension npm-deps):
 *
 *   - the spawn PRE-CHECK: an unresolvable npmDependencies declaration
 *     throws the actionable message BEFORE `Bun.spawn`, so no subprocess
 *     starts (kills the auto-disable crash-loop);
 *   - the crash ENRICHMENT: a child that dies mid-call rejects with the
 *     child's redacted stderr tail, NOT the opaque "Transport closed";
 *   - the AUTO-DISABLE reconcile: at the failure threshold the extension
 *     is disabled, the remedy is logged, and the registry is reloaded;
 *   - `redactStderrTail`: last-2000-char cap + credential masking.
 *
 * The DB + registry are mock.module'd (registered in mock-cleanup
 * MODULE_PATHS) so the crash/auto-disable paths run without a live DB; the
 * auto-disable remedy is asserted by capturing the logger's `process.stderr`
 * JSON line (the logger materializes before a module mock could take, so we
 * intercept its sink instead). Child subprocesses are REAL (spawned through
 * the real `ensureRunning`). Spec: tasks/extension-npm-deps.md.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let failureCount = 0;
const disableCalls: string[] = [];
let reloadCalled = false;

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => ++failureCount,
  disableExtension: async (id: string) => {
    disableCalls.push(id);
  },
  resetFailures: async () => {
    failureCount = 0;
  },
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        reloadCalled = true;
      },
    }),
  },
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess, redactStderrTail } from "../extensions/subprocess";

const echoPath = join(import.meta.dir, "helpers", "echo-extension.ts");
const crashPath = join(import.meta.dir, "helpers", "crash-extension.ts");
const crashSilentPath = join(import.meta.dir, "helpers", "crash-silent-extension.ts");
const allowedEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

beforeEach(() => {
  failureCount = 0;
  disableCalls.length = 0;
  reloadCalled = false;
});

describe("ExtensionProcess npm-dependency spawn pre-check", () => {
  test("an unresolvable dep throws the actionable message and never spawns", () => {
    const ep = new ExtensionProcess("dep-missing", echoPath, allowedEnv, {
      npmDependencies: { "totally-not-installed-xyz": "^1.0.0" },
    });
    expect(() => ep.ensureRunning()).toThrow(
      /Extension "dep-missing" requires npm package\(s\) it cannot resolve: totally-not-installed-xyz@\^1\.0\.0 \(missing\)/,
    );
    // No spawn happened → isRunning stays false (proves the crash-loop is
    // never entered: proc.exited never runs, no consecutive_failures).
    expect(ep.isRunning).toBe(false);
  });

  test("the pre-check error names the extension when extensionName is provided", () => {
    const ep = new ExtensionProcess("0000-uuid-like-id", echoPath, allowedEnv, {
      npmDependencies: { "totally-not-installed-xyz": "^1.0.0" },
      extensionName: "graded-card-scanner",
    });
    expect(() => ep.ensureRunning()).toThrow(/Extension "graded-card-scanner" requires/);
    expect(() => ep.ensureRunning()).not.toThrow(/0000-uuid-like-id/);
  });

  test("call() surfaces the pre-check failure (flows into the tool result)", async () => {
    const ep = new ExtensionProcess("dep-missing-2", echoPath, allowedEnv, {
      npmDependencies: { "totally-not-installed-xyz": "^1.0.0" },
    });
    await expect(ep.call("tools/call", { name: "x", arguments: {} })).rejects.toThrow(
      /cannot resolve/,
    );
    expect(ep.isRunning).toBe(false);
  });

  test("a resolvable dep passes the pre-check and the subprocess runs", async () => {
    // `yaml` is in the repo-root dependencies → resolves from the helpers
    // dir by walking up to the app node_modules.
    const ep = new ExtensionProcess("dep-ok", echoPath, allowedEnv, {
      npmDependencies: { yaml: "^2.8.2" },
    });
    try {
      const res = await ep.call("ping", { a: 1 });
      expect(res.result).toBeDefined();
      expect(ep.isRunning).toBe(true);
    } finally {
      ep.kill();
    }
  }, 15000);
});

describe("ExtensionProcess crash-surfacing", () => {
  test("a child that dies mid-call rejects with the stderr tail, not 'Transport closed'", async () => {
    const ep = new ExtensionProcess("crash-enrich", crashPath, allowedEnv);
    let caught: Error | null = null;
    try {
      await ep.callTool("boom", {});
    } catch (err) {
      caught = err as Error;
    } finally {
      ep.kill();
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("Extension subprocess crashed:");
    expect(caught!.message).toContain("Cannot find module 'ghost-pkg-xyz'");
    expect(caught!.message).not.toBe("Transport closed");
  }, 15000);

  test("a crash with EMPTY stderr rethrows the original 'Transport closed'", async () => {
    // The enrichment only fires when the child left a stderr tail — a
    // stderr-less crash must surface the original error unchanged (the
    // do-not-enrich branch).
    const ep = new ExtensionProcess("crash-silent", crashSilentPath, allowedEnv);
    let caught: Error | null = null;
    try {
      await ep.callTool("boom", {});
    } catch (err) {
      caught = err as Error;
    } finally {
      ep.kill();
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toBe("Transport closed");
  }, 15000);

  test("auto-disable at the threshold logs the remedy + reloads the registry", async () => {
    failureCount = 2; // the crash increments to 3 === AUTO_DISABLE_THRESHOLD
    // Capture the logger's stderr sink (see file header): the auto-disable
    // remedy is emitted via log.error → process.stderr.write(JSON line).
    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    const ep = new ExtensionProcess("crash-autodisable", crashPath, allowedEnv);
    try {
      await ep.callTool("boom", {}).catch(() => {});
      // The exit handler runs async off proc.exited: incrementFailures →
      // disableExtension → log.error → dynamic import + registry.reload.
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
      ep.kill();
    }

    expect(disableCalls).toContain("crash-autodisable");
    expect(reloadCalled).toBe(true);
    const line = stderrLines.find((l) =>
      l.includes("Extension auto-disabled after repeated crashes"),
    );
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!) as { threshold?: number; remedy?: string };
    expect(parsed.threshold).toBe(3);
    expect(parsed.remedy).toContain("re-enable from the Extensions page");
  }, 15000);
});

describe("redactStderrTail", () => {
  test("caps at the last 2000 chars (keeps the tail, drops the head)", () => {
    const long = "A".repeat(1500) + "TAILMARKER" + "B".repeat(600);
    const out = redactStderrTail(long);
    expect(out).toHaveLength(2000);
    expect(out.endsWith("B".repeat(600))).toBe(true);
    expect(out).not.toContain("A".repeat(1500));
  });

  test("short tails pass through unchanged", () => {
    expect(redactStderrTail("just a short line")).toBe("just a short line");
  });

  test("masks credential-shaped key=value / key: value pairs (case-insensitive)", () => {
    expect(redactStderrTail("api_key=sk-secret123")).toBe("api_key=[redacted]");
    expect(redactStderrTail("apikey=abc")).toBe("apikey=[redacted]");
    expect(redactStderrTail("password: hunter2")).toBe("password: [redacted]");
    expect(redactStderrTail("Bearer: abcdef.ghijkl")).toBe("Bearer: [redacted]");
    expect(redactStderrTail("SECRET=topsecret")).toBe("SECRET=[redacted]");
    expect(redactStderrTail("TOKEN=xyz")).toBe("TOKEN=[redacted]");
  });

  test("masks space-separated Bearer header echoes (the common HTTP-error shape)", () => {
    expect(redactStderrTail("Authorization: Bearer SUPERSECRET123")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactStderrTail("sent header bearer eyJhbGciOi.abc.def")).toBe(
      "sent header bearer [redacted]",
    );
  });

  test("masks quoted-JSON credential fields (the common JSON-dump shape)", () => {
    expect(redactStderrTail('{"token": "SUPERSECRET123"}')).toBe('{"token": "[redacted]"}');
    expect(redactStderrTail('{"apiKey":"abc123"}')).toBe('{"apiKey":"[redacted]"}');
    expect(redactStderrTail('{"password" : "hunter2", "user": "x"}')).toBe(
      '{"password" : "[redacted]", "user": "x"}',
    );
  });

  test("passes module-not-found lines through unchanged", () => {
    const line = "error: Cannot find module '@zxing/library' from '/app/ext/index.ts'";
    expect(redactStderrTail(line)).toBe(line);
  });
});
