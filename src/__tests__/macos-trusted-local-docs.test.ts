import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  RUNNER_MODE_VARIABLE,
  UNSANDBOXED_ACK_SENTENCE,
  UNSANDBOXED_ACK_VARIABLE,
} from "../extensions/runner-mode";

/**
 * Holds the macOS runbook's copy-paste block against the contract the code and
 * the compose file actually enforce.
 *
 * ## The bug this exists to prevent
 *
 * `docs/macos-local-dev.md` tells a macOS operator to paste two lines into
 * `.env.prod`, because the isolated runner cannot be reached from a container
 * on that platform. One of those lines carries an EXACT sentence that
 * `runner-mode.ts` compares literally — a mode the app refuses to start
 * without, and refuses to start with if it is misspelled. A doc that drifts
 * from that sentence by one character sends the reader into a boot loop whose
 * message is about the acknowledgement, not about the typo.
 *
 * ## Why this is not a tautology
 *
 * The expected values are IMPORTED from the module that enforces them and
 * cross-read from the compose file that selects the mode, rather than written
 * out here. Renaming the variable or editing the sentence in `runner-mode.ts`
 * fails this test until the runbook is updated to match, which is the whole
 * point.
 */

const ROOT = join(import.meta.dir, "..", "..");
const DOC = "docs/macos-local-dev.md";
const TRUSTED_LOCAL_COMPOSE = "deploy/extension-runner/compose.trusted-local.yml";

async function text(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

describe("macOS runbook — the trusted-local incantation", () => {
  test("documents the exact acknowledgement the code compares against", async () => {
    const doc = await text(DOC);
    expect(doc).toContain(`${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`);
  });

  test("points at the compose file that actually selects the mode", async () => {
    const doc = await text(DOC);
    expect(doc).toContain(`EZCORP_RUNNER_COMPOSE_FILE=${TRUSTED_LOCAL_COMPOSE}`);

    // …and that file must really set the mode, or the env line is a no-op.
    const compose = await text(TRUSTED_LOCAL_COMPOSE);
    expect(compose).toContain(`${RUNNER_MODE_VARIABLE}: trusted-local`);
    expect(compose).toContain(UNSANDBOXED_ACK_VARIABLE);
  });

  test("states the sandbox is absent, not merely reduced", async () => {
    const doc = await text(DOC);
    // The runbook's job is to stop someone pasting two lines without reading.
    expect(doc).toMatch(/WITHOUT a sandbox/);
    expect(doc).toMatch(/blast radius/);
    expect(doc).toMatch(/acknowledge/i);
  });
});
