import { expect, test } from "bun:test";
import { join } from "node:path";
import { getProjectRoot, resolveBundledExtensions } from "../extensions/bundled";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";

test("web-search bundled source requests only the shared host search capability", async () => {
  const entry = resolveBundledExtensions({}).find((candidate) => candidate.name === "web-search");
  expect(entry?.path).toBe("docs/extensions/examples/web-search");
  const manifest = await discoverFirstPartyManifest(join(getProjectRoot(), entry!.path));
  expect(manifest.permissions).toEqual({ search: "inherit" });
  expect((manifest.tools ?? []).map((tool) => tool.name).sort()).toEqual(["read-url", "search-web"]);
  expect(entry?.permissions.search).toBe("inherit");
  for (const capability of ["network", "env", "filesystem"] as const) {
    expect(manifest.permissions[capability]).toBeUndefined();
    expect(entry?.permissions[capability]).toBeUndefined();
  }
});
