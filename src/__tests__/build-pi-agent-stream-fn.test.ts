/**
 * Regression guard for the pi-agent-core 0.83.0 `streamFn` break — the one
 * item in that upgrade that a green typecheck and a green unit suite could
 * BOTH miss.
 *
 * WHAT BROKE
 * ----------
 * Up to 0.80.6 the Agent supplied its own transport default:
 *
 *     this.streamFn = options.streamFn ?? streamSimple;   // agent.js:116
 *
 * 0.83.0 replaced that with a host-installed hook:
 *
 *     this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
 *     // stream-fn.js: getDefaultStreamFn() THROWS when no host called
 *     //   setDefaultStreamFn(): "No default stream function configured."
 *
 * So an Agent constructed without `streamFn` throws IN ITS CONSTRUCTOR — i.e.
 * on every chat turn, in production, at runtime.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * `build-pi-agent-compaction.test.ts` — the file that otherwise covers
 * `buildPiAgent`'s option wiring — `mock.module`s `Agent` to a capture stub.
 * A stub constructor cannot throw the way the real one does, so that whole
 * suite stays green against a dead product. This file constructs the REAL
 * Agent through the REAL `buildPiAgent` and asserts on the transport it ends
 * up holding.
 *
 * `compaction-real-agent.integration.test.ts` also drives a real Agent through
 * `buildPiAgent`, but end-to-end over a loopback LLM — it would fail here too,
 * as one of a dozen assertions about compaction. This test names the defect.
 *
 * WHAT IS MOCKED, AND WHY IT IS NOT THE THING UNDER TEST
 * -----------------------------------------------------
 * Only `providers/credentials` — `buildPiAgent` closes over `getCredential`
 * for its `getApiKey` callback, which the Agent CONSTRUCTOR never invokes.
 * Mocking it keeps this file free of a DB and of the credential module's own
 * import graph. The `Agent`, the `streamSimple` transport and `buildPiAgent`
 * itself are all real.
 */
import { afterAll, describe, expect, test, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// The Agent constructor never calls this; see the header note.
mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "no-key-needed" }),
}));

import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";

// Import AFTER the credentials mock registers.
const { buildPiAgent } = await import("../runtime/stream-chat/build-pi-agent");

const piModel = () => ({
  id: "gpt-5.5",
  provider: "openai",
  api: "openai-responses",
  contextWindow: 272_000,
  maxTokens: 128_000,
});

/** Drive the production path exactly as `executor.ts:1276` does. */
function buildRealAgent(): Agent {
  const model = piModel();
  const ctx = { system: "sys", agentTools: [] } as any;
  const resolvedModel = {
    resolved: { provider: "openai", model: model.id, piModel: model },
    initialCred: { type: "apikey", token: "k" },
  } as any;
  return buildPiAgent(ctx, [], {} as any, resolvedModel, "conv-1", "conv-1");
}

describe("buildPiAgent wires a stream function into the REAL Agent", () => {
  test("constructing through the production path does not throw", () => {
    // Pre-fix on 0.83.0 this line throws "No default stream function
    // configured. Pass streamFn explicitly or call setDefaultStreamFn()."
    const agent = buildRealAgent();
    expect(agent).toBeInstanceOf(Agent);
  });

  test("the transport is pi-ai's streamSimple — the exact pre-0.83 default", () => {
    // Identity, not just "is a function": the point of the fix is that the
    // behaviour is UNCHANGED from 0.80.6, where the Agent imported this very
    // function from "@earendil-works/pi-ai/compat" and used it as its default.
    // Anything else here would be a silent transport swap.
    expect(buildRealAgent().streamFunction).toBe(streamSimple);
  });

  test("POSITIVE CONTROL: the installed Agent really does reject a missing streamFn", () => {
    // Proves the two assertions above are load-bearing rather than vacuous.
    // If a future pi-agent-core restores a built-in default, THIS fails first
    // and tells us the guard above has stopped guarding anything.
    expect(() => new Agent({ initialState: { model: piModel() } } as never)).toThrow(
      /No default stream function configured/,
    );
  });
});
