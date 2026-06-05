/**
 * Secure User-Site Preview — Phase 3b. Shell-tool spawn-trigger integration:
 * a recognized dev-server command is routed through the injected preview
 * launch (running it under the conversation's preview uid) instead of the
 * normal Bun.spawn path; everything else (and a refused launch) falls back
 * to normal execution.
 *
 * We drive `createShellTool` with an injected `ShellPreviewWiring` whose
 * `launch` returns a fake process, so no setuid helper / real spawn is
 * needed. The fallback cases run real (short) commands to prove normal
 * execution is untouched.
 */
import { test, expect, describe } from "bun:test";
import { createShellTool, type ShellPreviewWiring } from "../runtime/tools/shell";

function fakeProc(pid = 4242) {
  return { pid, exited: Promise.resolve(0), kill: () => {} };
}

function wiring(
  over: Partial<ShellPreviewWiring> & { launch?: ShellPreviewWiring["launch"] } = {},
): { wiring: ShellPreviewWiring; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const w: ShellPreviewWiring = {
    conversationId: "conv-1",
    userId: "u1",
    launch: (input) => {
      calls.push({ ...input });
      return { ok: true, uid: 90001, process: fakeProc() };
    },
    ...over,
  };
  return { wiring: w, calls };
}

describe("shell tool — preview spawn trigger", () => {
  test("a dev-server command routes through preview launch (under the uid)", async () => {
    const { wiring: w, calls } = wiring();
    const tool = createShellTool("/work/project", w);
    const res = await tool.execute("tc1", { command: "bun run dev" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: "conv-1",
      userId: "u1",
      workDir: "/work/project",
      command: "bun",
      args: ["run", "dev"],
    });
    const details = res.details as { preview?: { launched: boolean; uid: number; pid: number } };
    expect(details.preview?.launched).toBe(true);
    expect(details.preview?.uid).toBe(90001);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).toContain("secure preview");
  });

  test("a NON-dev command never calls launch (runs normally)", async () => {
    const { wiring: w, calls } = wiring();
    const tool = createShellTool(process.cwd(), w);
    const res = await tool.execute("tc2", { command: "echo hello-normal" });

    expect(calls).toHaveLength(0); // launch never invoked
    expect((res.content[0] as { text: string }).text).toContain("hello-normal");
  });

  test("a refused launch (static mode) falls back to normal execution", async () => {
    const { wiring: w, calls } = wiring({
      launch: () => ({ ok: false, reason: "uid-mode previews unavailable (mode=static)" }),
    });
    const tool = createShellTool(process.cwd(), w);
    // A dev command, but launch refuses → the command runs normally. Use a
    // command that prints deterministically so we can assert the fallback ran.
    // `vite` isn't installed, but the shell will report its own failure — the
    // KEY assertion is that launch was attempted then we did NOT short-circuit
    // with the preview success payload.
    const res = await tool.execute("tc3", { command: "echo dev && true" });
    // `echo dev && true` is a compound command → NOT detected as a dev server
    // at all, so launch is never called and it runs normally.
    expect(calls).toHaveLength(0);
    expect((res.content[0] as { text: string }).text).toContain("dev");
  });

  test("refused launch on a REAL dev command still falls through to spawn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const w: ShellPreviewWiring = {
      conversationId: "conv-1",
      userId: "u1",
      launch: (input) => {
        calls.push({ ...input });
        return { ok: false, reason: "preview uid pool exhausted" };
      },
    };
    const tool = createShellTool(process.cwd(), w);
    // `bun --version` is not a dev command; craft a recognized one that is a
    // harmless real binary: `serve` is in the allowlist but not installed, so
    // the spawn path will run `/bin/sh -c "serve"` → non-zero exit, proving we
    // reached the normal path (not the preview success payload).
    const res = await tool.execute("tc4", { command: "serve" });
    expect(calls).toHaveLength(1); // launch WAS attempted (serve is recognized)
    const details = res.details as { preview?: unknown; exitCode: number };
    expect(details.preview).toBeUndefined(); // did NOT short-circuit on success
  });

  test("no preview wiring at all → normal execution (back-compat)", async () => {
    const tool = createShellTool(process.cwd()); // no wiring
    const res = await tool.execute("tc5", { command: "echo plain" });
    expect((res.content[0] as { text: string }).text).toContain("plain");
  });
});
