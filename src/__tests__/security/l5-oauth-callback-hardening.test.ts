// Regression test for sec-L5: the OAuth callback subprocess must not be
// constructed by interpolating user-influenced values into a template-string
// script passed to `bun -e`.
//
// Pre-fix (src/auth/oauth-callback-server.ts@24-46):
//   const script = `
//     const server = Bun.serve({
//       port: ${port},
//       ...
//       const redirectTo = params
//         ? ${JSON.stringify(appCallbackUrl)} + "?" + params
//         : ${JSON.stringify(appCallbackUrl)};
//     ...
//   `;
//   Bun.spawn(["bun", "-e", script], ...)
// — values travel through JSON.stringify today, so injection is prevented
// at the moment, but the pattern is one dropped wrapper away from RCE on the
// developer's host. Any future maintenance edit that touches the script body
// could yield unescaped code execution. The L5 finding is specifically about
// this fragility.
//
// Fix (de30069):
//   - Worker body lives in its own file src/auth/oauth-callback-worker.ts.
//   - startOAuthCallbackServer spawns `bun run <worker>` — a static argv.
//   - Port + URL travel via EZCORP_OAUTH_CB_PORT / EZCORP_OAUTH_CB_URL env
//     vars. Bun.spawn does not shell-interpret env values, so there is no
//     interpolation path at all.
//   - Parent validates port (integer 1..65535) and URL (well-formed http(s))
//     at the spawn boundary as defense in depth.
//
// Strategy:
//   1. Static source inspection — read oauth-callback-server.ts and assert
//      the dangerous patterns (`"bun", "-e"`, an inline template literal
//      containing `Bun.serve`) are absent. This catches regressions that no
//      runtime test would notice if someone re-introduced an inline script.
//   2. Runtime spawn inspection — stub Bun.spawn via spyOn, call
//      startOAuthCallbackServer with valid inputs, and assert the argv is
//      ["bun", "run", <path ending in oauth-callback-worker.ts>] with the
//      port + URL delivered only via env.
//   3. The concatenated argv string must not contain the port or URL
//      anywhere — proves no interpolation path into command line.
//   4. Invalid port / URL are rejected before spawn is called.
//   5. The worker file itself exists and does not interpolate env values
//      into a template literal either (it reads them via process.env).
//
// Tests fix(sec-L5): de30069

import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { startOAuthCallbackServer } from "../../auth/oauth-callback-server";

const SERVER_SRC = resolve(import.meta.dir, "../../auth/oauth-callback-server.ts");
const WORKER_SRC = resolve(import.meta.dir, "../../auth/oauth-callback-worker.ts");

describe("sec-L5: oauth-callback-server hardening", () => {
  describe("static source inspection", () => {
    test("oauth-callback-server.ts does not use `bun -e` or inline Bun.serve template", () => {
      const src = readFileSync(SERVER_SRC, "utf8");

      // Dangerous pattern 1: spawning `bun -e <anything>` — this is the
      // exact pre-fix shape. Anything matching it is a regression.
      expect(src).not.toMatch(/["']-e["']/);

      // Dangerous pattern 2: an inline script that constructs Bun.serve via
      // a template literal. The worker body must live in its own file.
      // We look for `Bun.serve` inside a template literal construct.
      const templateWithBunServe = /`[^`]*Bun\.serve[^`]*`/s;
      expect(src).not.toMatch(templateWithBunServe);

      // Positive assertion: the hardened call shape is present.
      expect(src).toMatch(/"bun",\s*"run"/);
      expect(src).toContain("EZCORP_OAUTH_CB_PORT");
      expect(src).toContain("EZCORP_OAUTH_CB_URL");
    });

    test("oauth-callback-worker.ts exists and reads config from env, not argv", () => {
      expect(existsSync(WORKER_SRC)).toBe(true);
      const src = readFileSync(WORKER_SRC, "utf8");

      // Worker reads its config from process.env, not from a template.
      expect(src).toContain("process.env.EZCORP_OAUTH_CB_PORT");
      expect(src).toContain("process.env.EZCORP_OAUTH_CB_URL");

      // The worker must not itself be invoked via `-e`.
      expect(src).not.toMatch(/["']-e["']/);

      // The worker must validate its inputs before binding.
      expect(src).toMatch(/Number\.isInteger|parseInt/);
      expect(src).toContain("new URL");
    });
  });

  describe("runtime spawn inspection", () => {
    // We stub Bun.spawn to avoid actually binding a port. Each test records
    // the args + options, then restores the original in afterEach.
    type SpawnArgs = {
      cmd: string[];
      options: { env?: Record<string, string>; stdio?: unknown } | undefined;
    };
    let spawnCalls: SpawnArgs[] = [];
    let spawnSpy: ReturnType<typeof spyOn> | null = null;

    function installSpawnStub() {
      spawnCalls = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
        cmd: string[],
        options: SpawnArgs["options"],
      ) => {
        spawnCalls.push({ cmd, options });
        // Return a minimal Subprocess-shaped object so activeProcs.set
        // doesn't blow up and subsequent kill() calls are safe.
        return {
          kill: () => {},
          pid: 12345,
          exited: Promise.resolve(0),
        } as unknown as import("bun").Subprocess;
      }) as any);
    }

    afterEach(() => {
      spawnSpy?.mockRestore();
      spawnSpy = null;
    });

    test("valid call spawns `bun run <worker>` with port + URL in env only", () => {
      installSpawnStub();

      const port = 1455;
      const url = "http://localhost:5173/auth/callback";
      startOAuthCallbackServer(port, url);

      expect(spawnCalls.length).toBe(1);
      const { cmd, options } = spawnCalls[0]!;

      // argv shape: ["bun", "run", <absolute path ending in oauth-callback-worker.ts>]
      expect(cmd.length).toBe(3);
      expect(cmd[0]).toBe("bun");
      expect(cmd[1]).toBe("run");
      expect(cmd[2]).toContain("oauth-callback-worker.ts");

      // The port and URL must NOT appear anywhere in argv — not in cmd[2],
      // not via any other arg. This is the core injection-surface check: a
      // regression that re-introduces `bun -e <script with ${port}>` would
      // fail here.
      const argvText = cmd.join(" ");
      expect(argvText).not.toContain(String(port));
      expect(argvText).not.toContain("localhost:5173");
      expect(argvText).not.toContain("/auth/callback");

      // The `-e` flag must NEVER appear in the argv.
      expect(cmd).not.toContain("-e");

      // Values are delivered via env instead.
      expect(options?.env).toBeDefined();
      expect(options?.env?.EZCORP_OAUTH_CB_PORT).toBe(String(port));
      expect(options?.env?.EZCORP_OAUTH_CB_URL).toBe(url);
    });

    test("malicious-looking URL is NOT interpolated into argv", () => {
      installSpawnStub();

      // This is the kind of string that, if the pre-fix template literal
      // ever dropped JSON.stringify, would land as unescaped source and
      // execute. After the fix it must be confined to env.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: malicious payload fixture asserting template-like syntax stays inert
      const evilUrl = "http://localhost:5173/auth/callback?x=${process.exit(1)}`;//";

      // URL() will accept this (it's just a query string). startOAuthCallbackServer
      // normalises via new URL().toString() which percent-encodes.
      startOAuthCallbackServer(1455, evilUrl);

      expect(spawnCalls.length).toBe(1);
      const { cmd, options } = spawnCalls[0]!;

      // The evil fragment must not appear in argv.
      const argvText = cmd.join(" ");
      expect(argvText).not.toContain("process.exit");
      expect(argvText).not.toContain("`");
      expect(argvText).not.toContain("${");

      // It lives only in env, and env is not shell-interpreted by Bun.spawn.
      expect(options?.env?.EZCORP_OAUTH_CB_URL).toBeDefined();
    });

    test("invalid port is rejected before spawn", () => {
      installSpawnStub();

      expect(() => startOAuthCallbackServer(-1, "http://localhost/auth/callback")).toThrow(/invalid.*port/i);
      expect(() => startOAuthCallbackServer(70000, "http://localhost/auth/callback")).toThrow(/invalid.*port/i);
      expect(() => startOAuthCallbackServer(1.5, "http://localhost/auth/callback")).toThrow(/invalid.*port/i);

      expect(spawnCalls.length).toBe(0);
    });

    test("invalid URL is rejected before spawn", () => {
      installSpawnStub();

      expect(() => startOAuthCallbackServer(1455, "not a url")).toThrow(/invalid.*callback/i);
      // javascript: URL parses successfully but must be rejected by the
      // protocol guard — defense against someone passing a non-http scheme.
      expect(() => startOAuthCallbackServer(1455, "javascript:alert(1)")).toThrow(/invalid/i);
      expect(() => startOAuthCallbackServer(1455, "file:///etc/passwd")).toThrow(/invalid/i);

      expect(spawnCalls.length).toBe(0);
    });
  });
});
