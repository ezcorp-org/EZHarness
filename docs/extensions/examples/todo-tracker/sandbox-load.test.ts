// Phase post-perm-cleanup, task B6 — sandbox-load smoke.
//
// Goal: prove that `index.ts` loads cleanly under the production
// sandbox-preload (`src/extensions/runtime/sandbox-preload.ts`). Before
// the migration, the top-level `Bun.$` find shell-out + `Bun.file().text()`
// would trip the preload's shell + filesystem deniers at the FIRST tool
// call (and crash the subprocess). Module load itself was previously
// fine because the deniers only fire on use, not import — but the
// migration to host-mediated `fsList` / `fsRead` removes the dependency
// on the deny-listed primitives entirely. This test asserts module
// load remains clean.
//
// What this test covers:
//   - Spawn `bun --preload <sandbox-preload> -e "import 'index.ts'; process.exit(0)"`
//     with `EZCORP_FS_ALLOWED=1` set.
//   - Assert exit code is 0 and stderr contains no "Extension sandbox:"
//     poison message.
//
// What this test does NOT cover:
//   - Live JSON-RPC `initialize` round-trip (would require a real host
//     paired to the subprocess). The spec
//     (`tasks/post-perm-cleanup.md` "Sandbox-load test pattern") allows
//     either the full RPC handshake or this simpler exit-code probe;
//     wiring real channel framing here is non-trivial and behavior
//     coverage lives in the existing `todo-tracker-sdk-integration`
//     and `todo-tracker/e2e-server-pipeline` test files. This test is
//     the module-load smoke.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../../../../src/extensions/runtime/sandbox-preload.ts",
);

const ENTRYPOINT = resolve(import.meta.dir, "./index.ts");

describe("todo-tracker sandbox-load smoke", () => {
  test("module loads without throwing under the production sandbox-preload", () => {
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
          // todo-tracker only NEEDS fs at scan-todos call time, not
          // at module load. Set the flag anyway to mirror the
          // production env shape — this also means a future
          // load-time preflight (e.g. resolveProjectRoot from the SDK)
          // wouldn't surface as a module-load failure here.
          EZCORP_FS_ALLOWED: "1",
        },
      },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).not.toContain("Extension sandbox:");
    expect(proc.exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});
