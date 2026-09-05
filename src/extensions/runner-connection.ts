import { isAbsolute } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { RunnerClient } from "@ezcorp/extension-runner";
import { LifecycleError } from "./v4/types";

export function getConfiguredExtensionRunner(): RunnerClient {
  const socketPath = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const token = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  if (!socketPath || !isAbsolute(socketPath) || !token || token.length < 32) throw new LifecycleError("runner_unconfigured", "Configure the extension runner socket and its host authentication token.");
  return new RunnerClient({ socketPath, token });
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
