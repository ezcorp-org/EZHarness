import { expect, test } from "bun:test";
import { chmod, rm, symlink, writeFile, join, workspaceText, canonicalJson, FileBlobStore, getFiles, putFiles, runnerBusyRetryMs, root, blobs } from "../../__tests__/helpers/durable-lifecycle-fixture";

test("runner-busy backpressure grows to its bounded durable maximum", () => {
    expect([runnerBusyRetryMs(1), runnerBusyRetryMs(2), runnerBusyRetryMs(6), runnerBusyRetryMs(99)]).toEqual([1_000, 2_000, 30_000, 30_000]);
  });

test("compiled artifacts can exceed source limits without relaxing workspace admission", async () => {
    const files = { "extension.js": "x".repeat(21 * 1024 * 1024) };
    await expect(putFiles(blobs, files)).rejects.toThrow();
    const digest = await putFiles(blobs, files, "artifact");
    expect(workspaceText((await getFiles(blobs, digest, "artifact"))["extension.js"], "extension.js").length).toBe(files["extension.js"].length);
    await expect(getFiles(blobs, digest)).rejects.toThrow();
  });

test("concurrent identical writes are content addressed and tampering fails", async () => {
    const bytes = new TextEncoder().encode(canonicalJson({ "file.ts": "one" }));
    const results = await Promise.all([blobs.put(bytes), blobs.put(bytes)]);
    expect(results[0]).toBe(results[1]);
    expect(await blobs.get(results[0]!)).toEqual(bytes);
    await expect(writeFile(join(root, results[0]!), "corrupt")).rejects.toThrow();
    await chmod(join(root, results[0]!), 0o600);
    await writeFile(join(root, results[0]!), "corrupt");
    await expect(blobs.get(results[0]!)).rejects.toMatchObject({ code: "artifact_corrupt" });
  });

test("symlink objects and roots are refused", async () => {
    const target = join(root, "target");
    await writeFile(target, "secret");
    await symlink(target, join(root, "e".repeat(64)));
    await expect(blobs.get("e".repeat(64))).rejects.toThrow();
    const linkRoot = `${root}-link`;
    await symlink(root, linkRoot);
    try { await expect(new FileBlobStore(linkRoot).put(new Uint8Array())).rejects.toMatchObject({ code: "unsafe_blob_root" }); } finally { await rm(linkRoot); }
  });
