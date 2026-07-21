/**
 * Coverage for the two fire-and-forget rejection nets on `ExtensionProcess`
 * (`onDrainError` + `onExitHandlerError`).
 *
 * Both are the `.catch` arms of promise chains that are intentionally NOT
 * awaited: the stderr-drain loop and the unexpected-exit handler. Their bodies
 * only ever run when their chain rejects, which the happy-path suites
 * (`ext-sdk-subprocess.test.ts` drives a real child that drains + exits
 * normally) never trigger — so they get their own targeted file that drives a
 * REAL rejection through each handler exactly as `.catch(handler)` would, and
 * asserts the failure is LOGGED and NEVER rethrown (the chain resolves).
 *
 * A separate small file (not folded into `subprocess.test.ts`) because that
 * suite overrides `ExtensionProcess.prototype.ensureRunning` (a Bun JIT-SIGILL
 * workaround) and cannot attribute coverage to the real class members.
 */
import { describe, expect, spyOn, test } from "bun:test";

import { ExtensionProcess } from "../extensions/subprocess";

const echoPath = `${import.meta.dir}/helpers/echo-extension.ts`;
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

// The handlers are private bound fields — reach them the same way the runtime
// `.catch(this.onDrainError)` wiring does (by reference), via a narrow cast.
type Nets = {
  onDrainError: (err: unknown) => void;
  onExitHandlerError: (err: unknown) => void;
};
function nets(ep: ExtensionProcess): Nets {
  return ep as unknown as Nets;
}

describe("ExtensionProcess fire-and-forget rejection nets", () => {
  test("onDrainError logs the drain failure at debug and never rethrows", async () => {
    const ep = new ExtensionProcess("drain-ext", echoPath, baseEnv);
    const { onDrainError } = nets(ep);

    // `debug` is suppressed at the default LOG_LEVEL=info, so raise this one
    // subsystem (mirrors an operator running EZCORP_DEBUG=extensions/subprocess)
    // to make the emitted line observable on stdout.
    const prevDebug = process.env.EZCORP_DEBUG;
    process.env.EZCORP_DEBUG = "extensions/subprocess";
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      // Drive a REAL rejection through the handler as the `.catch` arm would:
      // the chain must RESOLVE (proves not rethrown) and the failure logged.
      await expect(
        Promise.reject(new Error("decoder boom")).catch(onDrainError),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
      if (prevDebug === undefined) delete process.env.EZCORP_DEBUG;
      else process.env.EZCORP_DEBUG = prevDebug;
    }

    const line = writes.find((w) => w.includes("Unexpected error draining stderr"));
    expect(line).toBeDefined();
    expect(line).toContain("drain-ext"); // the extensionId is threaded through
    expect(line).toContain("decoder boom"); // the rejection reason is surfaced
  });

  test("onExitHandlerError logs the exit-handler failure at error and never rethrows", async () => {
    const ep = new ExtensionProcess("exit-ext", echoPath, baseEnv);
    const { onExitHandlerError } = nets(ep);

    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await expect(
        Promise.reject(new Error("exit boom")).catch(onExitHandlerError),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    const line = writes.find((w) => w.includes("Extension process exit handler failed"));
    expect(line).toBeDefined();
    expect(line).toContain("exit-ext");
    expect(line).toContain("exit boom");
  });
});
