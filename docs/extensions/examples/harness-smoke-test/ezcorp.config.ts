import { defineExtension } from "../../../../src/extensions/sdk/define";
import { handleRequest } from "./index";

// Canonical regression fixture for the deterministic & loop-proof
// extension builder. This is the EXACT extension an in-app agent built
// in conversation 92ac355d… and then looped on ("install it / yes" ↔
// "use the ping tool"). It now ships as a fixture that exercises every
// loop-fix end-to-end:
//
//   - idempotent `installFromLocal` (re-install ⇒ refresh, not raw SQL)
//   - deterministic acceptance: the `smokeTest` below makes
//     `ezcorp ext verify` a machine-checked PASS, not a hallucination.
//
// The `ping` tool returns a PRETTY-printed `{ "ok": true, … }` envelope
// so the spec-locked `expect.textIncludes` (`"ok": true`, with the
// post-colon space) is a literal substring of the round-tripped output.
export default defineExtension({
  schemaVersion: 2,
  name: "harness-smoke-test",
  version: "1.0.0",
  description:
    "Canonical loop-incident regression fixture: a minimal ping tool wired to the deterministic smokeTest acceptance gate.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "ping",
      description:
        "Echo an { ok: true } envelope back to the caller. Exists solely to give the deterministic acceptance gate a tool to round-trip.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Arbitrary text echoed back in the envelope.",
          },
        },
      },
      handler: handleRequest,
    },
  ],
  // Deterministic acceptance contract (spec §Phase E, verbatim).
  smokeTest: {
    tool: "ping",
    input: { message: "hello harness" },
    expect: { textIncludes: '"ok": true' },
  },
  permissions: {},
});
