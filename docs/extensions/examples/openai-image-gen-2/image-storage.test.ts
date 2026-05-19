import { describe, expect, test, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import { saveImageToDisk, EXTENSION_NAME } from "./image-storage";

let root = "";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// `saveImageToDisk` routes IO through `@ezcorp/sdk/runtime`'s `fsMkdir`
// + `fsWrite` (Phase 3 host-mediated reverse-RPC). Bun unit tests run
// in-process and have no host attached, so we stub `getChannel().request`
// for `mkdir` + `write` and route them to real disk IO. Mirrors the
// task-stack test pattern.
//
// `EZCORP_FS_ALLOWED=1` satisfies the SDK's pre-flight gate without
// granting any real permission — the stub IS the host.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
    }
    if (method === "ezcorp/fs.write") {
      // `content` is base64 for binary, raw for utf-8 — saveImageToDisk
      // always passes a Uint8Array, so encoding is binary.
      const content = p.content as string;
      const encoding = p.encoding as string;
      const bytes = encoding === "binary"
        ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(content);
      writeFileSync(path, bytes);
      return { bytes: bytes.byteLength, resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `image-storage test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
  // beforeEach leaves dirs around on failure; best-effort cleanup of
  // the common prefix. Individual tests also rm their own tree.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* noop */ }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oig2-"));
  // Re-install stub — the global preload's afterEach drops the channel
  // singleton between tests.
  installFsStub();
});

describe("saveImageToDisk", () => {
  test("writes the decoded bytes under <projectRoot>/.ezcorp/extension-data/<name>/generated/", async () => {
    const { relPath, url } = await saveImageToDisk("aGVsbG8=", "image/png", { projectRoot: root });
    expect(relPath.startsWith("generated/")).toBe(true);
    expect(relPath.endsWith(".png")).toBe(true);
    expect(url).toBe(`/api/ext-files/${EXTENSION_NAME}/${relPath}`);
    const abs = join(root, ".ezcorp", "extension-data", EXTENSION_NAME, relPath);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs).toString("utf8")).toBe("hello");
  });

  test("chooses extension from mime type", async () => {
    const png = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const jpg = await saveImageToDisk("AAA=", "image/jpeg", { projectRoot: root });
    const webp = await saveImageToDisk("AAA=", "image/webp", { projectRoot: root });
    const gif = await saveImageToDisk("AAA=", "image/gif", { projectRoot: root });
    expect(png.relPath.endsWith(".png")).toBe(true);
    expect(jpg.relPath.endsWith(".jpg")).toBe(true);
    expect(webp.relPath.endsWith(".webp")).toBe(true);
    expect(gif.relPath.endsWith(".gif")).toBe(true);
  });

  test("defaults to .png for unknown mime types", async () => {
    const { relPath } = await saveImageToDisk("AAA=", "image/bmp", { projectRoot: root });
    expect(relPath.endsWith(".png")).toBe(true);
  });

  test("emits a URL under /api/ext-files/<extension name>/", async () => {
    const { url } = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    expect(url.startsWith(`/api/ext-files/${EXTENSION_NAME}/generated/`)).toBe(true);
  });

  test("two calls produce distinct filenames", async () => {
    const a = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const b = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    expect(a.relPath).not.toBe(b.relPath);
  });

  test("creates parent directory if missing", async () => {
    // root dir exists but extension-data subtree doesn't — still works.
    const { relPath } = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const abs = join(root, ".ezcorp", "extension-data", EXTENSION_NAME, relPath);
    expect(existsSync(abs)).toBe(true);
  });
});
