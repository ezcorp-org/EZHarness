import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolveDependencies } from "../../packages/@ezcorp/extension-runner/src/dependencies";

for (const provider of ["incus-sandbox", "infisical-secrets"]) {
  test(`${provider} package passes the isolated runner dependency policy`, async () => {
    const packageJson = await readFile(new URL(`../../extensions/${provider}/package.json`, import.meta.url), "utf8");
    const resolved = await resolveDependencies({ "package.json": packageJson });
    expect(resolved["package-lock.json"]).toBeDefined();
  });
}
