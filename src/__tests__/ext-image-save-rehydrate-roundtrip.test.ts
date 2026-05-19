/**
 * Contract + round-trip coverage for the ext-files write/read pipeline.
 *
 * The production bug that caused "model can't see previous images" had
 * three silent failure modes, each of which the tests below would have
 * caught before deploy:
 *
 *  1. `saveImageToDisk` (in the extension) and `resolveExtFilesPath` (in
 *     the server-side resolver) drift apart on path convention. One of
 *     them changes — e.g. adds a `v2/` segment, switches to hashed
 *     directories — and suddenly saves go one place and reads look
 *     another. The `path convention contract` test block pins both sides
 *     to the same format.
 *
 *  2. Round-trip byte corruption: the extension writes bytes that don't
 *     decode back to what the rehydrator produces (base64 off-by-one,
 *     MIME drift). The `save → rehydrate` test writes real fixtures
 *     through the extension module and reads them back through the
 *     rehydrator, asserting byte-for-byte equality.
 *
 *  3. MIME inference divergence — writer and reader derive the MIME
 *     type independently; a silently renamed file extension could make
 *     one treat it as image/png and the other as octet-stream, which
 *     the rehydrator would then skip. Covered inline.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Thin Node-fs stubs for the extension's fsMkdir/fsWrite calls. The
// host-RPC path in @ezcorp/sdk/runtime requires a live channel; the
// fixtures in beforeEach sit on the real filesystem (mkdtempSync), so
// direct node:fs delegation is byte-identical to what the host's
// ezcorp/fs.* handlers would produce. Without this, saveImageToDisk's
// fsMkdir trips the `EZCORP_FS_ALLOWED !== "1"` guard at fs.ts:165.
mock.module("@ezcorp/sdk/runtime", () => ({
  fsExists: async (path: string) => {
    try { statSync(path); return true; } catch { return false; }
  },
  fsRead: async (path: string, opts?: { encoding?: "utf-8" | "binary" }) => {
    const buf = readFileSync(path);
    if (opts?.encoding === "binary") return new Uint8Array(buf);
    return buf.toString("utf-8");
  },
  fsMkdir: async (path: string, opts?: { recursive?: boolean }) => {
    await fsp.mkdir(path, { recursive: opts?.recursive === true });
    return { resolvedPath: path };
  },
  fsWrite: async (path: string, content: string | Uint8Array) => {
    const isBinary = content instanceof Uint8Array;
    const bytes = isBinary
      ? content.byteLength
      : Buffer.byteLength(content as string);
    await fsp.writeFile(path, isBinary ? Buffer.from(content) : (content as string));
    return { bytes, resolvedPath: path };
  },
  getChannel: () => ({ start: () => {} }),
  createToolDispatcher: () => {},
}));

import {
  resolveExtFilesPath,
  extensionDataRoot,
  mimeTypeForPath,
} from "../chat/attachments/ext-files-resolver";
import {
  rehydrateAssistantMessageContent,
  statExtFilesImage,
  loadExtFilesImage,
} from "../chat/attachments/history-rehydrate";
import {
  saveImageToDisk,
  EXTENSION_NAME,
} from "../../docs/extensions/examples/openai-image-gen-2/image-storage";

// Real PNG header bytes — we're not testing image decoding, just that
// bytes survive the write → read → base64 pipeline intact. First 8
// bytes are the canonical PNG signature; the rest is arbitrary.
const FIXTURE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const FIXTURE_PNG_B64 = Buffer.from(FIXTURE_PNG).toString("base64");
const FIXTURE_JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const FIXTURE_JPG_B64 = Buffer.from(FIXTURE_JPG).toString("base64");

let projectRoot = "";

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "roundtrip-"));
});

afterEach(() => {
  if (projectRoot) {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
    projectRoot = "";
  }
});

// ── Contract: path convention matches across save + read ──────────────
describe("path convention contract", () => {
  test("saveImageToDisk writes under the exact path the resolver reads from", async () => {
    // Save a fake image using the extension's production code.
    const saved = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    // Parse the URL the extension produces (the canonical wire format
    // the LLM sees in tool outputs).
    const urlMatch = saved.url.match(/^\/api\/ext-files\/([^/]+)\/(.+)$/);
    expect(urlMatch).not.toBeNull();
    const [, nameFromUrl, relFromUrl] = urlMatch!;
    expect(nameFromUrl).toBe(EXTENSION_NAME);

    // Resolve via the server-side resolver from the SAME projectRoot.
    const resolved = resolveExtFilesPath(nameFromUrl, relFromUrl, projectRoot);
    expect(resolved).not.toBeNull();

    // The file the extension wrote must be exactly the file the
    // resolver points at. If either side drifts (e.g. an extra path
    // segment, different casing, base64/url-encoding a segment), this
    // fails with a path comparison that makes the drift obvious.
    const extWrote = join(
      projectRoot,
      ".ezcorp",
      "extension-data",
      EXTENSION_NAME,
      saved.relPath,
    );
    expect(resolved!.absPath).toBe(extWrote);
  });

  test("extensionDataRoot matches the directory prefix saveImageToDisk uses", async () => {
    const saved = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    // Any file the extension saves must sit under the resolver's data
    // root — otherwise the HTTP route's containment check would reject
    // the path as a traversal attempt.
    const root = extensionDataRoot(EXTENSION_NAME, projectRoot);
    const expectedAbs = join(root, saved.relPath);
    const resolved = resolveExtFilesPath(EXTENSION_NAME, saved.relPath, projectRoot);
    expect(resolved!.absPath).toBe(expectedAbs);
  });

  test("MIME inference matches between writer (file extension) and resolver (path)", async () => {
    // Both sides derive MIME from the file extension. Drift here would
    // mean the writer labels a file image/png while the resolver returns
    // something else — silently stripping it from rehydration.
    const png = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    const jpg = await saveImageToDisk(FIXTURE_JPG_B64, "image/jpeg", { projectRoot });
    expect(mimeTypeForPath(png.relPath)).toBe("image/png");
    expect(mimeTypeForPath(jpg.relPath)).toBe("image/jpeg");
  });
});

// ── Round-trip: extension saves → rehydrator reads ────────────────────
describe("save → rehydrate round-trip", () => {
  test("bytes saved by extension come back byte-for-byte through the rehydrator", async () => {
    const saved = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });

    // Sanity: file actually exists on disk where the extension says.
    const diskBytes = readFileSync(
      join(projectRoot, ".ezcorp", "extension-data", EXTENSION_NAME, saved.relPath),
    );
    expect(Buffer.from(FIXTURE_PNG).equals(diskBytes)).toBe(true);

    // Now read back through the rehydrator — the code path that runs
    // on every subsequent chat turn. Provide projectRoot via opts.cwd
    // so we don't depend on process.cwd() for this assertion.
    const info = await statExtFilesImage(saved.url, { cwd: projectRoot });
    expect(info).not.toBeNull();
    expect(info!.mimeType).toBe("image/png");
    expect(info!.sizeBytes).toBe(FIXTURE_PNG.length);

    const img = await loadExtFilesImage(info!.absPath, info!.mimeType);
    expect(img).not.toBeNull();
    expect(img!.mimeType).toBe("image/png");
    expect(img!.data).toBe(FIXTURE_PNG_B64);
  });

  test("full rehydrateAssistantMessageContent pipeline against extension-produced text", async () => {
    // What the tool actually puts in the assistant context is a full
    // markdown line, not just a URL. Exercise the end-to-end parser +
    // resolver + loader pipeline against that literal text.
    const saved = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    const assistantText = `Generated 1 image with OpenAI.\n\n![a cat](${saved.url})`;

    const parts = await rehydrateAssistantMessageContent(assistantText, { cwd: projectRoot });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: assistantText });
    expect(parts[1]).toEqual({
      type: "image",
      data: FIXTURE_PNG_B64,
      mimeType: "image/png",
    });
  });

  test("multiple images written by extension all survive the round-trip", async () => {
    // The extension often returns multiple variants in one tool call.
    // Ensure every URL in its output resolves through the rehydrator,
    // not just the first one.
    const a = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    const b = await saveImageToDisk(FIXTURE_JPG_B64, "image/jpeg", { projectRoot });
    const text = `![](${a.url}) and ![](${b.url})`;

    const parts = await rehydrateAssistantMessageContent(text, { cwd: projectRoot });
    const images = parts.filter(
      (p: { type: string }): p is { type: "image"; data: string; mimeType: string } =>
        p.type === "image",
    );
    expect(images).toHaveLength(2);
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.data).toBe(FIXTURE_PNG_B64);
    expect(images[1]!.mimeType).toBe("image/jpeg");
    expect(images[1]!.data).toBe(FIXTURE_JPG_B64);
  });

  test("wiped file (simulating unmounted volume) fails resolution without throwing", async () => {
    // Reproduce the exact production failure mode: bytes were saved at
    // some point, then the directory they lived in got wiped out (e.g.
    // container restart on an ephemeral FS). The resolver must return
    // null, not throw — otherwise a single stale URL would crash the
    // whole turn.
    const saved = await saveImageToDisk(FIXTURE_PNG_B64, "image/png", { projectRoot });
    rmSync(join(projectRoot, ".ezcorp"), { recursive: true, force: true });

    const info = await statExtFilesImage(saved.url, { cwd: projectRoot });
    expect(info).toBeNull();

    // The full rehydrator pipeline behaves the same way — the URL
    // stays as text in the first part, and NO image part is produced.
    // The model retains the URL in prose but has no bytes to inspect.
    const parts = await rehydrateAssistantMessageContent(`![](${saved.url})`, { cwd: projectRoot });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("text");
  });
});
