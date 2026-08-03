/**
 * ez-factory — does the entrypoint actually BOOT?
 *
 * `../boot.test.ts` drives `start()` in-process with
 * `mock.module("@ezcorp/sdk/runtime", …)` replacing `createToolDispatcher`
 * and `getChannel` with inert spies. That is the right shape for asserting
 * WHAT gets registered, and it is structurally blind to WHETHER the
 * registration is legal — because the constraint being broken lives inside
 * the two functions it replaces:
 *
 *   `createToolDispatcher` forwards to a module-level `_register` hook in
 *   `packages/@ezcorp/sdk/src/runtime/rpc.ts` whose default value THROWS
 *   ("channel not ready"). The real hook is installed by
 *   `ensureDispatcherRegistered()`, which `channel.ts` calls from
 *   `getChannel()` and nowhere else. Calling `createToolDispatcher` before
 *   any `getChannel()` therefore kills the process at boot.
 *
 * That is exactly what shipped: every spawn of this extension exited 1
 * before serving a single frame, so the Hub console rendered "This page
 * failed to render" and no workflow tool step could ever dispatch. Nothing
 * in the mocked suite could see it.
 *
 * So this test spawns the REAL entrypoint as a REAL `bun` subprocess —
 * the only harness in which the ordering constraint exists at all.
 *
 * Cheap by construction: stdin is closed immediately, so the channel's
 * line reader hits EOF, the loop ends and the process exits 0. A boot
 * failure is a non-zero exit with the SDK's message on stderr.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");

/** Spawn the entrypoint with stdin already at EOF and collect its outcome. */
async function bootEntrypoint(): Promise<{
  exitCode: number;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", ENTRYPOINT], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
}

describe("ez-factory entrypoint — real subprocess boot", () => {
  test("boots without tripping the SDK's channel-not-ready guard", async () => {
    const { exitCode, stderr } = await bootEntrypoint();

    // The named symptom first, so a regression reads as itself rather than
    // as a bare exit-code mismatch.
    expect(stderr).not.toContain("channel not ready");
    // …and the general one, so ANY boot-time throw fails this test too.
    expect(stderr).not.toContain("error:");
    expect(exitCode).toBe(0);
  }, 30_000);
});
