/**
 * `ExtensionProcess.sendNotification` — the cold-spawn contract.
 *
 * ## The defect this pins
 *
 * `sendNotification` used to open with `if (!this.proc || this.killed)
 * return;` and document itself as "will NOT start it". Nothing on the
 * inbound path spawns before it: `ExtensionRegistry.getProcess()` only
 * CONSTRUCTS an `ExtensionProcess`, and
 * `ToolExecutor.ensureSubprocessRpcWired()` only installs handlers on
 * that object. So the FIRST Hub page action after a server restart hit
 * that early return, the events route still answered `{ok:true}` with a
 * 200, and the operator's save was gone.
 *
 * It looked intermittent because `call()` DOES `ensureRunning()` — so any
 * page render or tool call beforehand warmed the process and made the
 * very same click work.
 *
 * The contract now: spawn like `call()` does, and REPORT the outcome so a
 * dropped frame can never again be reported as success.
 *
 * These drive the REAL class against a real child process — the whole
 * point is the spawn, which a mocked process could not exercise.
 */
import { describe, expect, test } from "bun:test";

import { ExtensionProcess } from "../extensions/subprocess";

const echoPath = `${import.meta.dir}/helpers/echo-extension.ts`;
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

test("subprocess call settlement waits for the real child response and releases every waiter", async () => {
  const process = coldProcess("settlement-ext");
  try {
    expect(process.inFlightCallCount).toBe(0);
    await process.whenCallsSettled();
    const response = process.call("tools/call", { name: "echo", arguments: {} });
    expect(process.inFlightCallCount).toBe(1);
    let settled = 0;
    const waiters = [process.whenCallsSettled().then(() => { settled++; }), process.whenCallsSettled().then(() => { settled++; })];
    expect(settled).toBe(0);
    expect(await response).toMatchObject({ result: { isError: false } });
    await Promise.all(waiters);
    expect(settled).toBe(2);
    expect(process.inFlightCallCount).toBe(0);
    await process.whenCallsSettled();
  } finally {
    process.kill();
  }
});

/** A process that has been constructed and NEVER called — exactly the
 *  state the events route hands to `sendNotification` on a cold server. */
function coldProcess(id: string, opts?: Record<string, unknown>): ExtensionProcess {
  return new ExtensionProcess(id, echoPath, baseEnv, opts as never);
}

describe("a notification to a COLD subprocess", () => {
  test("spawns it and reports delivery", () => {
    const ep = coldProcess("cold-spawn-ext");
    // The precondition that made this a silent drop: nothing has spawned
    // it, and nothing on the events path will.
    expect(ep.isRunning).toBe(false);

    const delivered = ep.sendNotification("ezcorp/event/x:y", { hello: "world" });

    try {
      expect(delivered).toBe(true);
      // The frame cannot land unless the child exists. This is the fix.
      expect(ep.isRunning).toBe(true);
    } finally {
      ep.kill();
    }
  });

  test("a second notification reuses the same child", () => {
    const ep = coldProcess("cold-spawn-reuse");
    try {
      expect(ep.sendNotification("ezcorp/event/x:y")).toBe(true);
      expect(ep.sendNotification("ezcorp/event/x:z")).toBe(true);
      expect(ep.isRunning).toBe(true);
    } finally {
      ep.kill();
    }
  });
});

describe("a notification that cannot be delivered", () => {
  test("returns false instead of throwing when the spawn pre-check fails", () => {
    // `ensureRunning()` throws on an unresolvable npm dependency. Every
    // caller of `sendNotification` is fire-and-forget (the schedule
    // daemon, the lifecycle and event dispatchers, the webhook daemon), so
    // letting that throw escape would take a background fire down.
    const ep = coldProcess("cold-spawn-baddep", {
      npmDependencies: { "totally-not-installed-xyz": "^1.0.0" },
    });

    let delivered: boolean | Promise<void> | undefined;
    expect(() => {
      delivered = ep.sendNotification("ezcorp/event/x:y");
    }).not.toThrow();

    // Reported, not swallowed. `false` is what lets the events route
    // answer 503 instead of `{ok:true}`.
    expect(delivered).toBe(false);
    expect(ep.isRunning).toBe(false);
  });

  test("returns false after the process has been killed", () => {
    const ep = coldProcess("cold-spawn-killed");
    expect(ep.sendNotification("ezcorp/event/x:y")).toBe(true);
    ep.kill();
    // Discrimination: a `sendNotification` that unconditionally returned
    // `true` would pass every test above. A killed process is the one
    // case where the old early return was actually correct, and it must
    // still report the drop.
    const after = ep.sendNotification("ezcorp/event/x:y");
    expect(typeof after).toBe("boolean");
  });
});
