import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_IMAGE } from "@ezcorp/extension-runner";

/**
 * Holds the three places that spell the runner image's digest against each
 * other, so the pin cannot drift between them.
 *
 * ## The bug this exists to prevent
 *
 * `DEFAULT_IMAGE` is what a runner is built with, what every recipe records
 * as `image`, and what `runtime_profile_changed` compares at execution. The
 * runner README's pre-pull step and the SDK's MCP test each carry the same
 * digest as a LITERAL — the SDK cannot import it without depending upward on
 * the runner package. Update the pin in one place and the other two keep
 * pre-pulling or exercising an image the runner will never use.
 *
 * ## Why this is not a tautology
 *
 * `DEFAULT_IMAGE` is imported from the module that enforces it; the other
 * two values are read out of their files at test time. Nothing here restates
 * the digest.
 */

const ROOT = join(import.meta.dir, "..", "..");
const DIGEST = /^docker\.io\/oven\/bun@sha256:[a-f0-9]{64}$/;

async function text(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

describe("runner image pin", () => {
  test("is an immutable registry digest, as the runner itself requires", () => {
    expect(DEFAULT_IMAGE).toMatch(DIGEST);
  });

  test("the runner README pre-pulls the same image", async () => {
    const readme = await text("deploy/extension-runner/README.md");
    expect(readme).toContain(`Pre-pull \`${DEFAULT_IMAGE}\``);
  });

  test("the SDK's MCP test runs the same image", async () => {
    const sdkTest = await text("packages/@ezcorp/sdk/src/v4/mcp.test.ts");
    const refs = sdkTest.match(/docker\.io\/oven\/bun@sha256:[a-f0-9]{64}/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toBe(DEFAULT_IMAGE);
  });
});
