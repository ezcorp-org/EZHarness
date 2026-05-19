/**
 * Kokoro-TTS — REAL-MODEL nightly spec.
 *
 * Skipped by default. Set `EZCORP_E2E_KOKORO_REAL=1` to opt in. The
 * standard E2E run uses a `window.Worker` stub (see
 * `kokoro-tts-flow.spec.ts`) that mocks the wire protocol — that's
 * cheap, deterministic, and adequate for the host-side seams.
 *
 * This spec lives separately so a regression in kokoro-js, the WASM
 * runtime, or the bundled ONNX weights surfaces in the nightly run
 * without paying the multi-MB model-load cost on every PR.
 *
 * Stub-only — fill in the real flow when the nightly model harness is
 * wired up. The current implementation is a single skip-marked test
 * that documents the gating env var so a future agent (or human) can
 * extend it without re-deriving the convention.
 *
 * Tracked: docs/plans/2026-05-04 (or wherever the kokoro-tts plan
 * lives) — search for "kokoro-tts-realmodel" to find the open work
 * item. The standard spec covers the contract; this one covers the
 * model bundle itself.
 */
import { test, expect } from "./fixtures/test-base.js";

const REAL_MODEL_ENABLED = process.env.EZCORP_E2E_KOKORO_REAL === "1";

test.describe("Kokoro-TTS — real-model nightly", () => {
  test.skip(
    !REAL_MODEL_ENABLED,
    "Set EZCORP_E2E_KOKORO_REAL=1 to run the multi-MB ONNX model load.",
  );

  test("kokoro-js synthesizes a real WAV from a known input", async ({ page }) => {
    // Placeholder — the real harness needs:
    //   1. a chat conversation seeded with a deterministic assistant
    //      turn (short text → bounded synthesis time);
    //   2. NO worker stub (default Worker = real `kokoro-tts-worker.ts`);
    //   3. timeout bumped well past the 30s default to absorb the
    //      first-call WASM compile + ONNX weight load.
    //
    // For now the test is a marker so the file shows up in CI listings
    // and a future agent has a place to land the real assertions.
    expect(REAL_MODEL_ENABLED).toBe(true);
    void page; // suppress unused-arg lint until the body lands.
  });
});
