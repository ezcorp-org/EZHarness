import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { RunnerClient } from "@ezcorp/extension-runner";
import { LifecycleError } from "./v4/types";

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

export function getConfiguredExtensionRunner(): RunnerClient {
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

export function createLazyExtensionRunner(resolve: () => Runner = getConfiguredExtensionRunner): Runner {
  return {
    async build(input) { return resolve().build(input); },
    async start(input, reverseRpc) { return resolve().start(input, reverseRpc); },
    async cancel(id) { return resolve().cancel(id); },
    async inspect(id) { return resolve().inspect(id); },
    async collectArtifacts(digest) { return resolve().collectArtifacts(digest); },
  };
}
