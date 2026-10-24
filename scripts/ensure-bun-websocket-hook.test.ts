import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBunWebSocketHook } from "./ensure-bun-websocket-hook.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const INDEX = "websocket() {return this.#options.hooks.websocket}\nwebsocket: module.websocket || null,";
const HOOK = `async function get_hooks() {
\tlet handle;
\t({handle, init} = await import("./hooks.server-abc.js"));
\treturn {
\t\thandle,
\t\tinit
\t};
}
//#endregion`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ez-bun-ws-hook-"));
  roots.push(root);
  const server = join(root, "server");
  const chunks = join(server, "chunks");
  await mkdir(chunks, { recursive: true });
  await writeFile(join(server, "index.js"), INDEX);
  await writeFile(join(chunks, "exports-abc.js"), HOOK);
  await writeFile(join(chunks, "hooks.server-abc.js"), "export { handle, websocket };");
  return { server, chunks };
}

test("repairs exactly one split SvelteKit hook and is idempotent", async () => {
  const { server, chunks } = await fixture();
  await ensureBunWebSocketHook(server);
  const output = await readFile(join(chunks, "exports-abc.js"), "utf8");
  expect(output).toContain("let websocket;");
  expect(output).toContain("({websocket, handle,");
  expect(output).toContain("return {\n\t\twebsocket,\n\t\thandle,");
  await ensureBunWebSocketHook(server);
  expect(await readFile(join(chunks, "exports-abc.js"), "utf8")).toBe(output);
});

test("refuses missing or ambiguous generated hook chunks", async () => {
  const { server, chunks } = await fixture();
  await writeFile(join(chunks, "exports-abc.js"), "no hooks");
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("exactly one");
  await writeFile(join(chunks, "exports-abc.js"), HOOK);
  await writeFile(join(chunks, "exports-def.js"), HOOK);
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("exactly one");
  expect((await readdir(chunks)).length).toBe(3);
  await rm(join(chunks, "exports-def.js"));
  await writeFile(join(chunks, "exports-abc.js"), `${HOOK}\n${HOOK}`);
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("exactly one");
});

test("refuses absent server seam, hook export, or import", async () => {
  const { server, chunks } = await fixture();
  await writeFile(join(server, "index.js"), "no websocket method");
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("server seam");
  await writeFile(join(server, "index.js"), `${INDEX}\n${INDEX}`);
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("server seam");
  await writeFile(join(server, "index.js"), INDEX);
  await writeFile(join(chunks, "hooks.server-abc.js"), "export { handle };");
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("no WebSocket export");
  await writeFile(join(chunks, "hooks.server-abc.js"), "export { handle, websocket };");
  await writeFile(join(chunks, "exports-abc.js"), HOOK.replace("hooks.server-abc.js", "other.js"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("hook import changed");
});

test("refuses partial patches and changed generated function shapes", async () => {
  const { server, chunks } = await fixture();
  await writeFile(join(chunks, "exports-abc.js"), HOOK.replace("\tlet handle;", "\tlet websocket;\n\tlet handle;"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("partly patched");
  const complete = HOOK.replace("async function get_hooks() {\n\tlet handle;", "async function get_hooks() {\n\tlet websocket;\n\tlet handle;")
    .replace("({handle,", "({websocket, handle,")
    .replace("\treturn {\n\t\thandle,", "\treturn {\n\t\twebsocket,\n\t\thandle,");
  await writeFile(join(chunks, "exports-abc.js"), complete.replace("\treturn {\n\t\twebsocket,\n\t\thandle,", "\treturn {\n\t\twebsocket,\n\t\twebsocket,\n\t\thandle,"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("partly patched");
  await writeFile(join(chunks, "exports-abc.js"), complete.replace("({websocket, handle,", "({handle,\n\t({websocket, handle,"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("partly patched");
  await writeFile(join(chunks, "exports-abc.js"), HOOK.replace("\n//#endregion", ""));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("boundary changed");
  await writeFile(join(chunks, "exports-abc.js"), HOOK.replace("\treturn {\n\t\thandle,", "\treturn {\n\t\tother,"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("shape changed");
  await writeFile(join(chunks, "exports-abc.js"), HOOK.replace("\treturn {\n\t\thandle,", "\treturn {\n\t\thandle,\n\treturn {\n\t\thandle,"));
  await expect(ensureBunWebSocketHook(server)).rejects.toThrow("shape changed");
});
