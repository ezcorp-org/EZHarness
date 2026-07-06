import { test, expect, afterEach } from "bun:test";
// SMALL, isolated coverage shard for src/logger.ts's `debugMatches` no-match
// fall-through (the final `return false`). It MUST use a STATIC import of the
// logger — the sibling logger.test.ts re-`require()`s the module to pick up
// LOG_LEVEL changes, and a re-required copy is a second, separately-instrumented
// module instance that clobbers Bun's --coverage per-line attribution for this
// branch (a known Bun coverage-attribution drift: covered in a focused file,
// dropped in the larger require-busting suite). EZCORP_DEBUG is read live on
// every emit, so no re-import is needed to flip it.
import { logger } from "../logger";

afterEach(() => {
  delete process.env.EZCORP_DEBUG;
  delete process.env.LOG_LEVEL;
});

function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks;
}

test("debugMatches returns false when EZCORP_DEBUG is a non-empty list that matches no subsystem", () => {
  // raw is set + non-empty (skips the `!raw` guard), is not 1/true/*/all,
  // subsystem is defined (skips `!subsystem`), and the single list entry
  // "ext.other" neither equals nor namespaces "ext.foo" — so the loop completes
  // without returning true and execution reaches the final `return false`.
  process.env.EZCORP_DEBUG = "ext.other";
  const out = captureStdout(() => logger.child("ext.foo").debug("hidden"));
  // debugMatches → false ⇒ NOT raised to debug ⇒ default-info threshold hides it.
  expect(out.length).toBe(0);
});

test("the same subsystem's info still emits (proves it is the debug RAISE that is absent, not the logger)", () => {
  process.env.EZCORP_DEBUG = "ext.other";
  const out = captureStdout(() => logger.child("ext.foo").info("visible"));
  expect(out.length).toBe(1);
  const parsed = JSON.parse(out[0] ?? "{}");
  expect(parsed.subsystem).toBe("ext.foo");
  expect(parsed.level).toBe("info");
});
