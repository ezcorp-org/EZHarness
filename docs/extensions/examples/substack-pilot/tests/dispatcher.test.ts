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
});
