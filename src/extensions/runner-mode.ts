import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LifecycleError } from "./v4/types";

/**
 * Which extension runner this host uses.
 *
 *   `isolated`      — the authenticated rootless-Podman runner on the host
 *                     (`deploy/extension-runner/`). The default and the only
 *                     mode ever described as isolated.
 *   `trusted-local` — `TrustedLocalRunner`: extensions run as plain
 *                     processes inside the app's own account, with NONE of
 *                     the seven controls the runner lists in
 *                     `TRUSTED_LOCAL_OMITTED_CONTROLS`. Non-root and
 *                     no-new-privs, nothing else. Each build and each release
 *                     still needs a human's per-digest acknowledgement, which
 *                     the runner enforces itself (`authorize()`).
 *
 * Fail-closed, modelled on `isTestSurfaceEnabled()` (`src/test-surface.ts`):
 * the dangerous mode needs TWO independent variables, the second of which is
 * a sentence rather than a `1` so it cannot be enabled by copying a line from
 * an e2e config. Any incoherent combination refuses to resolve at all —
 * `validateEnv()` calls this at boot, so a misconfigured host does not start
 * rather than starting in the wrong mode. Unlike the test surface this is
 * deliberately permitted under `NODE_ENV=production`: self-hosters on
 * macOS/Windows are the audience (see
 * docs/decisions/2026-09-12-extension-runner-install-burden.md).
 */
export type ExtensionRunnerMode = "isolated" | "trusted-local";

export const RUNNER_MODE_VARIABLE = "EZCORP_EXTENSION_RUNNER";
export const UNSANDBOXED_ACK_VARIABLE = "EZCORP_EXTENSIONS_UNSANDBOXED_ACK";
/** The exact value `UNSANDBOXED_ACK_VARIABLE` must carry. A sentence, on purpose. */
export const UNSANDBOXED_ACK_SENTENCE = "I-understand-extensions-run-with-the-apps-full-powers";

/** `runnerProfile` stamped on approvals and releases in each mode. Switching
 *  modes therefore invalidates every existing approval (`stale_approval` in
 *  `v4/lifecycle.ts` `checkApproval`) and forces re-approval under the new
 *  terms — free, and exactly the behaviour a downgrade needs. */
export const ISOLATED_PROFILE = "rootless-podman-v4";
export const TRUSTED_LOCAL_PROFILE = "trusted-local-v4";

const ISOLATED_VARIABLES = ["EZCORP_EXTENSION_RUNNER_SOCKET", "EZCORP_EXTENSION_RUNNER_TOKEN", "EZCORP_EXTENSION_RUNNER_TOKEN_FILE"] as const;

function invalid(message: string): LifecycleError {
  return new LifecycleError("runner_mode_invalid", message);
}

export function getExtensionRunnerMode(env: Record<string, string | undefined> = process.env): ExtensionRunnerMode {
  const mode = env[RUNNER_MODE_VARIABLE];
  const ack = env[UNSANDBOXED_ACK_VARIABLE];
  if (mode === undefined || mode === "" || mode === "isolated") {
    // A stray acknowledgement with the mode off is not harmless noise: it
    // means someone's config and their intent disagree. Refuse rather than
    // guess which one is right.
    if (ack !== undefined) throw invalid(`${UNSANDBOXED_ACK_VARIABLE} is set but ${RUNNER_MODE_VARIABLE} is not "trusted-local". Remove the acknowledgement or select the mode explicitly.`);
    return "isolated";
  }
  if (mode !== "trusted-local") throw invalid(`${RUNNER_MODE_VARIABLE} must be unset, "isolated", or "trusted-local" (got ${JSON.stringify(mode)}).`);
  if (ack !== UNSANDBOXED_ACK_SENTENCE) throw invalid(`${RUNNER_MODE_VARIABLE}=trusted-local runs extensions WITHOUT a sandbox. To confirm, set ${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE} — exactly that sentence.`);
  const conflicting = ISOLATED_VARIABLES.filter((name) => env[name] !== undefined);
  if (conflicting.length) throw invalid(`${RUNNER_MODE_VARIABLE}=trusted-local and the isolated runner (${conflicting.join(", ")}) are both configured. Choose one.`);
  return "trusted-local";
}

export function isTrustedLocalMode(env: Record<string, string | undefined> = process.env): boolean {
  return getExtensionRunnerMode(env) === "trusted-local";
}

let bunDigest: Promise<string> | undefined;

/**
 * SHA-256 of the running bun binary. `TrustedLocalRunner` pins the binary it
 * executes extensions with and refuses to start if it changes
 * (`trusted_binary_changed`); the lifecycle stamps the same digest into
 * `runnerImageDigest` via `trustedLocalImage()`. Memoised: the binary does not
 * change while the process runs, and it is ~100 MB.
 */
export function trustedLocalBunDigest(): Promise<string> {
  bunDigest ??= readFile(process.execPath).then((bytes) => createHash("sha256").update(bytes).digest("hex")).catch((error: unknown) => {
    bunDigest = undefined;
    throw error;
  });
  return bunDigest;
}
