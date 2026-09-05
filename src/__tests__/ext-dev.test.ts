import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const writes = mock(() => { throw new Error("Legacy development must not write host state"); });
mock.module("../db/connection", () => ({ initDb: writes }));
mock.module("../extensions/installer", () => ({ installFromLocal: writes }));
mock.module("../db/queries/extensions", () => ({ listExtensions: writes, deleteExtension: writes }));
afterAll(() => restoreModuleMocks());
const { startDevServer } = await import("../extensions/sdk/dev");

test("legacy development rejects before config execution, DB writes or hot reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retired-development-"));
  const marker = join(directory, "executed");
  await Bun.write(join(directory, "ezcorp.config.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {};`);
  try {
    for (const signal of [undefined, AbortSignal.abort()]) {
      await expect(startDevServer({ extDir: directory, _signal: signal })).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    }
    await expect(startDevServer()).rejects.toThrow(/workspace.*build.*inspect.*human approval/);
    expect(writes).not.toHaveBeenCalled();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
