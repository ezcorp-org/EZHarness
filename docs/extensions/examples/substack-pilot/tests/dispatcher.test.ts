import { test, expect, describe } from "bun:test";
import { tools } from "../index";
import manifest from "../ezcorp.config";

// The dispatcher's exported `tools` map MUST contain a handler for every
// tool declared in the manifest, otherwise a tools/call from the host
// would 404 at the JSON-RPC layer.

describe("dispatcher tools map", () => {
  test("contains a handler for every manifest tool", () => {
    const manifestNames = (manifest.tools ?? []).map((t) => t.name);
    const handlerNames = Object.keys(tools);
    for (const name of manifestNames) {
      expect(handlerNames).toContain(name);
    }
  });
  test("does not register stray handlers not in the manifest", () => {
    const manifestNames = new Set((manifest.tools ?? []).map((t) => t.name));
    for (const handlerName of Object.keys(tools)) {
      expect(manifestNames.has(handlerName)).toBe(true);
    }
  });

  // Invoke the handler arrows themselves (not just assert the map shape):
  // each forwards to its lib fn, which short-circuits on invalid args with
  // a toolError BEFORE any network/DB — so this covers the index.ts
  // handler wiring without external side effects.
  test("summarize_urls handler forwards to the lib (invalid args → toolError)", async () => {
    const out = await tools.summarize_urls!({});
    expect((out as { isError?: boolean }).isError).toBe(true);
  });

  test("generate_substack_draft handler forwards to the lib (invalid args → toolError)", async () => {
    const out = await tools.generate_substack_draft!({}, undefined);
    expect((out as { isError?: boolean }).isError).toBe(true);
  });
});
