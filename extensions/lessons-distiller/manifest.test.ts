import { expect, test } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";
import manifest from "./ezcorp.config";

test("lessons metadata satisfies the canonical v4 contract", () => {
  expect(() => validateManifest(manifest)).not.toThrow();
});
