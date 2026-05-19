// Phase post-perm-cleanup, task A8 — sandbox-load smoke.
//
// Goal: prove that `index.ts` loads cleanly under the production
// sandbox-preload (`src/extensions/runtime/sandbox-preload.ts`). Before
// the migration, the top-level `import { existsSync } from "fs"` would
// trip the preload's FS_MODULES poison at module-load and the
// subprocess would crash before any JSON-RPC frame was exchanged.
//
// What this test covers:
//   - Spawn `bun --preload <sandbox-preload> -e "import 'index.ts'; process.exit(0)"`
//     with `EZCORP_FS_ALLOWED=1` and `EZCORP_PROJECT_ROOT=/tmp/...` set
//     (the env vars the host injects at spawn time per `buildAllowedEnv`).
//   - Assert exit code is 0 and stderr contains no "Extension sandbox:"
//     poison message.
//
// What this test does NOT cover:
//   - Live JSON-RPC `initialize` round-trip. The spec
//     (`tasks/post-perm-cleanup.md` "Sandbox-load test pattern") allows
//     either the full RPC handshake or this simpler exit-code probe;
//     wiring real channel framing here is non-trivial and `ext-sdk-
//     subprocess.test.ts` already exercises framing through
//     `ExtensionProcess` for other extensions. This test is the
//     module-load smoke; behavior is covered by `index.test.ts` (62
//     tests) under an in-process channel stub.
//
// The check is a pure exit-code check (no `Bun.spawn` flake): if the
// extension's module body throws under the sandbox preload, exit code
// will be non-zero and stderr will name the poisoned module.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../../../../src/extensions/runtime/sandbox-preload.ts",
);

const ENTRYPOINT = resolve(import.meta.dir, "./index.ts");

describe("task-stack sandbox-load smoke", () => {
  test("module loads without throwing under the production sandbox-preload", () => {
    // `bun --preload <preload> -e "<code>"` — `import.meta.main` is
    // false for the imported file, so `index.ts`'s `getChannel().start()`
    // gate doesn't fire. We're testing module body + the lazy fs
    // resolveProjectRoot path.
    const proc = Bun.spawnSync(
      [
        "bun",
        "--preload",
        SANDBOX_PRELOAD_PATH,
        "-e",
        `import ${JSON.stringify(ENTRYPOINT)}; process.exit(0);`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          EZCORP_FS_ALLOWED: "1",
          EZCORP_PROJECT_ROOT: "/tmp/task-stack-sandbox-load-test-root",
        },
      },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    // The poison message starts with "Extension sandbox:" — if any
    // module-load path imports a poisoned module, that string appears.
    expect(stderr).not.toContain("Extension sandbox:");
    // Module-load throws would surface a non-zero exit code.
    expect(proc.exitCode).toBe(0);
    // Sanity — extension shouldn't write anything to stdout on plain
    // module load (no `import.meta.main` path).
    expect(stdout).toBe("");
  });
});
