/**
 * Empty shim that stands in for `path` and `fs/promises` in the
 * browser bundle. `kokoro-js` statically imports both at the top of
 * its bundle for its Node code path:
 *
 *   import s from "path";
 *   import i from "fs/promises";
 *
 * Then it runtime-checks `if (i && Object.hasOwn(i, "readFile"))`
 * before using them, falling back to `fetch` from HuggingFace when
 * absent. Its package.json declares `"browser": { "path": false,
 * "fs/promises": false }`, but Vite's `optimizeDeps` pre-bundler
 * doesn't honour the `browser` field for transitive deps. So we
 * map both via `resolve.alias` in vite.config.ts to this file —
 * the `import` resolves to an empty default export, the runtime
 * check sees `undefined`, and the fetch fallback runs.
 *
 * Default-exporting an empty object is enough for both: kokoro-js
 * accesses `path.resolve(...)` only inside the same `if (i)` block
 * that already proves `fs/promises` exists, so neither is reached
 * in the browser.
 */
export default {} as never;
