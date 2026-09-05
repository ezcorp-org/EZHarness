import { test, expect, describe } from "bun:test";
import { resolveBundledExtensions } from "../bundled";
import { BUNDLED_CEILING, getCeiling } from "../bundled-ceiling";
import { BUNDLED_DRAFTS_ALLOWLIST } from "../drafts-handler";
import { validateManifest } from "@ezcorp/extension-contract";
import { discoverFirstPartyManifest } from "../../__tests__/helpers/first-party-manifest";
import { join } from "node:path";

const extensionDirectory = join(import.meta.dir, "..", "..", "..", "docs/extensions/examples/extension-author");

describe("extension-author migration diagnostic wiring", () => {
  test("the diagnostic remains in the reviewed bundled source inventory", () => {
    const entry = resolveBundledExtensions().find((candidate) => candidate.name === "extension-author");
    expect(entry?.path).toBe("docs/extensions/examples/extension-author");
  });

  test("the bundled descriptor grants no authoring authority", () => {
    const entry = resolveBundledExtensions().find((candidate) => candidate.name === "extension-author")!;
    expect(entry.permissions).toEqual({ grantedAt: {} });
  });

  test("the ceiling cannot restore filesystem or draft authority", () => {
    expect(getCeiling("extension-author")).toEqual({ grantedAt: {} });
    expect(BUNDLED_CEILING["extension-author"]).toEqual({ grantedAt: {} });
  });

  test("the actual worker discovers canonical v4 metadata", async () => {
    const manifest = await discoverFirstPartyManifest(extensionDirectory);
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(4);
  });

  test("no extension-side create, modify, validate, or install tool survives", async () => {
    const manifest = await discoverFirstPartyManifest(extensionDirectory);
    expect((manifest.tools ?? []).map((tool) => tool.name)).toEqual(["migration_status"]);
  });

  test("the worker cannot request host capabilities", async () => {
    const manifest = await discoverFirstPartyManifest(extensionDirectory);
    expect(manifest.permissions).toEqual({});
  });

  test("legacy name recognition is not a capability grant", async () => {
    expect(BUNDLED_DRAFTS_ALLOWLIST.has("extension-author")).toBe(true);
    const manifest = await discoverFirstPartyManifest(extensionDirectory);
    expect(manifest.permissions.custom).toBeUndefined();
    expect(manifest.permissions.filesystem).toBeUndefined();
  });
});
