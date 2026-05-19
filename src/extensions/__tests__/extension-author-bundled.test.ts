// Wiring tests for the bundled `extension-author` extension.
//
// Pin:
//   - the entry exists in `BUNDLED_EXTENSIONS` (consumed by
//     `ensureBundledExtensions` at boot)
//   - the manifest at `docs/extensions/examples/extension-author/`
//     parses through `validateManifestV2`
//   - the row in `BUNDLED_CEILING` matches the manifest's declared
//     permissions (the security ceiling vs declared-shape invariant)
//   - `BUNDLED_DRAFTS_ALLOWLIST` includes the name (defense-in-depth
//     gate inside `drafts-handler.ts`)

import { test, expect, describe } from "bun:test";
import { resolveBundledExtensions } from "../bundled";
import { BUNDLED_CEILING, getCeiling } from "../bundled-ceiling";
import { BUNDLED_DRAFTS_ALLOWLIST } from "../drafts-handler";
import { loadManifestFresh } from "../loader";
import { validateManifestV2 } from "../manifest";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const EXT_DIR = join(REPO_ROOT, "docs/extensions/examples/extension-author");

describe("extension-author bundled wiring", () => {
  test("appears in BUNDLED_EXTENSIONS", () => {
    const entries = resolveBundledExtensions();
    const entry = entries.find((e) => e.name === "extension-author");
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("docs/extensions/examples/extension-author");
  });

  test("entry's permissions include filesystem + custom.drafts", () => {
    const entries = resolveBundledExtensions();
    const entry = entries.find((e) => e.name === "extension-author");
    expect(entry).toBeDefined();
    expect(entry!.permissions.filesystem).toContain(
      "$CWD/.ezcorp/extension-data/extension-author",
    );
    expect(entry!.permissions.custom?.drafts?.kinds).toEqual(["extension"]);
  });

  test("BUNDLED_CEILING row exists and matches the manifest", () => {
    const ceiling = getCeiling("extension-author");
    expect(ceiling).not.toBeNull();
    expect(ceiling!.filesystem).toEqual([
      "$CWD/.ezcorp/extension-data/extension-author",
    ]);
    expect(ceiling!.custom?.drafts?.kinds).toEqual(["extension"]);
    // Ceiling MUST NOT widen any field beyond the bundled-install grant.
    expect(BUNDLED_CEILING["extension-author"]).toBeDefined();
  });

  test("on-disk manifest parses through validateManifestV2", async () => {
    const manifest = await loadManifestFresh(EXT_DIR);
    const result = validateManifestV2(manifest);
    if (!result.valid) {
      throw new Error(`extension-author manifest invalid: ${result.errors.join(", ")}`);
    }
    expect(result.valid).toBe(true);
  });

  test("on-disk manifest declares all seven tools", async () => {
    const manifest = await loadManifestFresh(EXT_DIR);
    const toolNames = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "create_extension",
      "discard_draft",
      "install_draft",
      "list_drafts",
      "read_draft",
      "validate_extension",
      "write_draft_file",
    ]);
  });

  test("on-disk manifest's permissions match the bundled grant", async () => {
    const manifest = await loadManifestFresh(EXT_DIR);
    expect(manifest.permissions.filesystem).toEqual([
      "$CWD/.ezcorp/extension-data/extension-author",
    ]);
    expect(manifest.permissions.custom?.drafts?.kinds).toEqual(["extension"]);
    // Negative scope checks — confirm we didn't accidentally widen.
    expect(manifest.permissions.network).toBeUndefined();
    expect(manifest.permissions.shell).toBeFalsy();
    expect(manifest.permissions.env).toBeUndefined();
    expect(manifest.permissions.storage).toBeFalsy();
  });

  test("BUNDLED_DRAFTS_ALLOWLIST includes the name", () => {
    expect(BUNDLED_DRAFTS_ALLOWLIST.has("extension-author")).toBe(true);
  });
});
