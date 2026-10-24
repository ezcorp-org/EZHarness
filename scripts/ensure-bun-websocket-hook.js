import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GET_HOOKS = "async function get_hooks() {";
const DECLARATION = `${GET_HOOKS}\n\tlet websocket;\n\tlet handle;`;
const ASSIGNMENT = "({websocket, handle,";
const RETURN = "\treturn {\n\t\twebsocket,\n\t\thandle,";

function count(source, value) {
  return source.split(value).length - 1;
}

function exactlyOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error("Bun adapter WebSocket hook shape changed");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

/** Repair the pinned adapter's split-chunk get_hooks omission after adapt().
 * Refuse a missing, ambiguous or partly patched output. */
export async function ensureBunWebSocketHook(serverDir) {
  const server = await readFile(join(serverDir, "index.js"), "utf8");
  if (count(server, "websocket() {return this.#options.hooks.websocket}") !== 1
    || count(server, "websocket: module.websocket || null,") !== 1) {
    throw new Error("Bun adapter WebSocket server seam changed");
  }

  const chunksDir = join(serverDir, "chunks");
  const candidates = (await readdir(chunksDir)).filter(name => /^exports-[^/]+\.js$/.test(name));
  const found = [];
  for (const name of candidates) {
    const path = join(chunksDir, name);
    const source = await readFile(path, "utf8");
    if (source.includes(GET_HOOKS)) found.push({ path, source });
  }
  if (found.length !== 1 || count(found[0].source, GET_HOOKS) !== 1) {
    throw new Error("Bun adapter must emit exactly one get_hooks chunk");
  }
  const { path, source } = found[0];
  const start = source.indexOf(GET_HOOKS);
  const end = source.indexOf("\n//#endregion", start);
  if (end < 0) throw new Error("Bun adapter get_hooks boundary changed");
  const hook = source.slice(start, end);
  const importPath = /await import\("(\.\/hooks\.server-[^"/]+\.js)"\)/.exec(hook)?.[1];
  if (!importPath) throw new Error("Bun adapter hook import changed");
  const hookModule = await readFile(join(chunksDir, importPath), "utf8");
  if (!/^export \{[^\n]*\bwebsocket\b[^\n]*\};?$/m.test(hookModule)) {
    throw new Error("Bun adapter hook module has no WebSocket export");
  }

  const patched = [count(hook, DECLARATION), count(hook, ASSIGNMENT), count(hook, RETURN)];
  if (patched.every(value => value === 1)) {
    if (hook.includes(`${GET_HOOKS}\n\tlet handle;`) || hook.includes("({handle,")
      || hook.includes("\treturn {\n\t\thandle,")) {
      throw new Error("Bun adapter WebSocket hook is partly patched");
    }
    return;
  }
  if (patched.some(Boolean)) throw new Error("Bun adapter WebSocket hook is partly patched");
  let repaired = exactlyOnce(hook, `${GET_HOOKS}\n\tlet handle;`, DECLARATION);
  repaired = exactlyOnce(repaired, "({handle,", ASSIGNMENT);
  repaired = exactlyOnce(repaired, "\treturn {\n\t\thandle,", RETURN);
  await writeFile(path, source.slice(0, start) + repaired + source.slice(end));
}
