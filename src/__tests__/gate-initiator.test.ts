/**
 * The ambient gate initiator (`src/auth/gate-initiator.ts`).
 *
 * One AsyncLocalStorage, one writer (`hooks.server.ts`), two readers: the
 * permission gate and the remote-tool registry. The properties below are the
 * ones a second copy of this module — or an "improvement" that stored
 * `undefined` instead of skipping the scope — would quietly break, and neither
 * failure surfaces anywhere else: a gate would simply record nothing, and the
 * routes that confine on it would fall back to their open side.
 */

import { describe, expect, test } from "bun:test";
import {
  getAmbientGateInitiator,
  runWithGateInitiator,
} from "../auth/gate-initiator";

describe("runWithGateInitiator", () => {
  test("the value is readable anywhere in the synchronous subtree", () => {
    const seen = runWithGateInitiator("api-key:k1", () => {
      const inner = () => getAmbientGateInitiator();
      return inner();
    });
    expect(seen).toBe("api-key:k1");
  });

  test("it survives awaits — the case every real gate is in", () => {
    // A gate is opened many awaits deep inside a `streamChat` promise the
    // route deliberately never awaits. If the store did not follow the async
    // subtree it would be readable only at the hook and nowhere that matters.
    return runWithGateInitiator("session:u1", async () => {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 1));
      expect(getAmbientGateInitiator()).toBe("session:u1");
    });
  });

  test("a detached promise chain keeps the scope it was CREATED in", () => {
    // `streamChat`'s promise is not awaited by the request, so the scope has
    // exited by the time the tool runs. What matters is where the chain was
    // created, not who is awaiting it.
    let detached: Promise<string | undefined> | undefined;
    runWithGateInitiator("api-key:detached", () => {
      detached = (async () => {
        await new Promise<void>((r) => setTimeout(r, 1));
        return getAmbientGateInitiator();
      })();
    });
    return expect(detached).resolves.toBe("api-key:detached");
  });

  test("returns whatever the callback returns", () => {
    expect(runWithGateInitiator("session:u1", () => 42)).toBe(42);
    expect(runWithGateInitiator(undefined, () => 42)).toBe(42);
  });

  test("outside any scope the initiator is undefined, never a stale value", () => {
    runWithGateInitiator("api-key:k1", () => getAmbientGateInitiator());
    expect(getAmbientGateInitiator()).toBeUndefined();
  });

  test("an undefined initiator runs OUTSIDE the scope rather than shadowing it", () => {
    // The one behaviour with a security consequence. Storing `undefined` would
    // let an unauthenticated request blank an enclosing scope — and would give
    // "no initiator" two representations, so a consumer testing for one would
    // miss the other.
    const seen = runWithGateInitiator("session:outer", () =>
      runWithGateInitiator(undefined, () => getAmbientGateInitiator()),
    );
    expect(seen).toBe("session:outer");
  });

  test("nested scopes shadow, and the outer one is restored on exit", () => {
    const trace: Array<string | undefined> = [];
    runWithGateInitiator("api-key:outer", () => {
      trace.push(getAmbientGateInitiator());
      runWithGateInitiator("api-key:inner", () => {
        trace.push(getAmbientGateInitiator());
      });
      trace.push(getAmbientGateInitiator());
    });
    expect(trace).toEqual(["api-key:outer", "api-key:inner", "api-key:outer"]);
  });
});
