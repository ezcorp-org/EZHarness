// hostFs FsLayer catch-branch coverage for the file-organizer subprocess.
//
// The default `fs` layer (`hostFs`) wraps the host-mediated SDK fs calls
// (`fsRead`/`fsExists`/`fsList`) in try/catch so a transient host error
// degrades to a safe empty value (null / false / []) rather than crashing a
// page render. Every other test injects an in-memory `FsLayer` via
// `_setFsForTests`, so the REAL hostFs wrappers are never exercised. Here we
// mock the SDK fs functions to throw and drive `_setFsForTests(null)` (which
// restores the genuine hostFs) through the read* path so each catch arm
// runs.
//
// The mock DELEGATES to the real `@ezcorp/sdk/runtime` for everything else
// (definePage/getChannel/toolResult/…) and only overrides the four fs fns —
// the renders we call don't touch the channel, just the read* helpers. This
// file runs in its own bun process (per-file isolation) so the mock can't
// contaminate index.test.ts.
import { afterEach, describe, expect, mock, test } from "bun:test";

const realRuntime = await import("@ezcorp/sdk/runtime");
const realSnapshot = { ...realRuntime };

const throwES = () => {
  throw new Error("EIO: host fs unavailable");
};

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realSnapshot,
  default: realSnapshot,
  fsRead: async () => throwES(),
  fsExists: async () => throwES(),
  fsList: async () => throwES(),
  // fsWrite is intentionally NOT overridden — hostFs.write has no catch
  // (a write failure must surface), and the renders under test never write.
}));

const { _setFsForTests, _hostFsForTests, renderOverview, renderFolders } = await import("./index");

afterEach(() => {
  _setFsForTests(null);
});

describe("hostFs degrades each host-fs error to a safe empty value", () => {
  test("hostFs.read swallows a thrown host error → null", async () => {
    expect(await _hostFsForTests().read("/any/path")).toBeNull();
  });

  test("hostFs.exists swallows a thrown host error → false", async () => {
    expect(await _hostFsForTests().exists("/any/path")).toBe(false);
  });

  test("hostFs.list swallows a thrown host error → [] (no production caller)", async () => {
    expect(await _hostFsForTests().list("/any/path")).toEqual([]);
  });

  test("hostFs.write delegates to the host fsWrite (no catch — failures surface)", async () => {
    // hostFs.write has NO try/catch (a persistence failure MUST surface,
    // unlike reads which degrade). It simply awaits the host-mediated
    // fsWrite. Outside a wired subprocess the host RPC isn't available, so
    // the call rejects — which is exactly the "no swallow" contract, and
    // it executes the wrapper body either way.
    await expect(_hostFsForTests().write("/tmp/fo-hostfs-write-probe.json", "{}")).rejects.toBeDefined();
  });

  test("renderOverview survives when every host read throws (read→null)", async () => {
    _setFsForTests(null); // restore the genuine hostFs (SDK fns now throw)
    const tree = await renderOverview();
    // No config readable ⇒ onboarding/empty render, never a crash.
    expect(tree).toBeDefined();
    expect(tree.title).toBeDefined();
  });

  test("renderFolders survives when the host fs throws", async () => {
    _setFsForTests(null);
    const tree = await renderFolders();
    expect(tree).toBeDefined();
  });

  test("daemonRunning probe: hostFs.exists throw → 'Watcher stopped'", async () => {
    _setFsForTests(null);
    const tree = await renderOverview();
    expect(JSON.stringify(tree)).toContain("Watcher stopped");
  });
});
