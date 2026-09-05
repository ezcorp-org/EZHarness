import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, loadManifestFresh } from "../extensions/loader";

for (const config of [undefined, "export default {};", "export default {schemaVersion:2,resources:{memory:'256MB'}};", "export default {schemaVersion:4};"]) {
  test(`host SDK consumers cannot load local configuration: ${config ?? "missing"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-host-load-"));
    const marker = join(directory, "executed");
    try {
      await Bun.write(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 2, name: "legacy-json" }));
      if (config) await Bun.write(join(directory, "ezcorp.config.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed"); ${config}`);
      for (const load of [loadManifest, loadManifestFresh]) {
        await expect(load(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
