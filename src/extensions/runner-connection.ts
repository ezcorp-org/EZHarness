import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { RunnerClient } from "@ezcorp/extension-runner";
import { LifecycleError } from "./v4/types";
import { getExtensionRunnerMode } from "./runner-mode";
import { resolveTrustedLocalRunner } from "./trusted-local-runner";

function readRunnerToken(path: string): string {
  if (!isAbsolute(path)) throw new Error("Invalid credential path");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > 4096) throw new Error("Invalid credential file");
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 4096) throw new Error("Invalid credential size");
    return buffer.subarray(0, length).toString("utf8").trim();
  } finally {
    closeSync(descriptor);
  }
}

export function getConfiguredExtensionRunner(): Runner {
  // The fail-closed two-key gate (`runner-mode.ts`) decides WHICH runner;
  // it never decides whether a given extension may build or run. In
  // trusted-local mode that stays with `TrustedLocalRunner.authorize()`,
  // which refuses every build and worker start lacking a live per-digest
  // human approval. A misconfigured gate throws its own `runner_mode_invalid`
  // here rather than being folded into `runner_unconfigured` below, because
  // the two need different fixes and `validateEnv()` names them at boot.
  if (getExtensionRunnerMode() === "trusted-local") return createLazyExtensionRunner(resolveTrustedLocalRunner);
  const socketPath = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const tokenValue = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  const tokenFile = process.env.EZCORP_EXTENSION_RUNNER_TOKEN_FILE;
  try {
    if (!socketPath || !isAbsolute(socketPath) || (tokenValue !== undefined && tokenFile !== undefined)) throw new Error("Invalid runner settings");
    const token = tokenFile === undefined ? tokenValue : readRunnerToken(tokenFile);
    if (!token || token.length < 32 || Buffer.byteLength(token) > 4096 || /\s/u.test(token) || [...token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Invalid runner credential");
    return new RunnerClient({ socketPath, token });
  } catch {
    throw new LifecycleError("runner_unconfigured", "Configure an absolute extension runner socket and one valid host credential: token or token file.");
  }
}

// Answers the same question as getConfiguredExtensionRunner without throwing, so
// a caller can branch on host settings. It reuses that validation rather than
// restating it; neither a RunnerClient nor the lazy trusted-local runner opens
// anything until its first call, so this is a pure settings check in both modes.
export function isExtensionRunnerConfigured(): boolean {
  try { getConfiguredExtensionRunner(); return true; }
  catch { return false; }
}

/**
 * `resolve` may be sync (the socket client is cheap to construct) or async
 * (the in-process trusted-local runner digests bun and bundles the SDK on
 * first use). Every method already awaits, so both shapes cost the same
 * here — one wrapper, not two.
 */
export function createLazyExtensionRunner(resolve: () => Runner | Promise<Runner> = getConfiguredExtensionRunner): Runner {
  return {
    async build(input) { return (await resolve()).build(input); },
    async start(input, reverseRpc) { return (await resolve()).start(input, reverseRpc); },
    async cancel(id) { return (await resolve()).cancel(id); },
    async inspect(id) { return (await resolve()).inspect(id); },
    async collectArtifacts(digest) { return (await resolve()).collectArtifacts(digest); },
  };
}
