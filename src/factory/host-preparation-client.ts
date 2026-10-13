import type { BuildResult, Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { createGatewayTransport, GatewayStatusError, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { digestObject } from "../extensions/v4/blobs";
import { FactoryHostLaunchRefusal } from "./host-launch-client";
import { FACTORY_HOST_PREPARATION_PATH, FACTORY_HOST_PREPARATION_TIMEOUT_MS } from "./runner/host-launch-service";

/** Longer than the host's own build bound, so the host always answers first. */
export const FACTORY_HOST_PREPARATION_CLIENT_TIMEOUT_MS = FACTORY_HOST_PREPARATION_TIMEOUT_MS + 30_000;
/** The transport's own response cap; the host service answers at most 4 MiB (supervisor-services.ts). */
const PREPARED_LIMIT_BYTES = 16 * 1024 * 1024;

export class FactoryHostPreparationError extends Error {
  constructor(readonly code: "host_preparation_invalid" | "host_preparation_artifact_mismatch" | "host_preparation_not_built", message: string) {
    super(`${code}: ${message}`);
    this.name = "FactoryHostPreparationError";
  }
}

/**
 * The supervisor as the builder `FactoryPackagePreparations` prepares through (C05 "Prepare a bound
 * package for dispatch", W4H-26). The product holds no container runtime: it sends the release
 * source over the W01b mutual-TLS host-launch service, under the same host identity binding as a
 * launch, and the supervisor builds it in the store its launches read.
 *
 * The answer's artifact files must digest to the artifact digest the answer names, or nothing is
 * kept. `FactoryPackagePreparations` then compares that digest with its binding's and writes a
 * receipt only on equality, so both sides of the wire check a digest.
 */
export async function createFactoryHostPreparationClient(options: GatewayTransportOptions & { readonly tenantId: string }): Promise<Pick<Runner, "build" | "collectArtifacts">> {
  const { tenantId, ...transportOptions } = options;
  const transport = await createGatewayTransport({ ...transportOptions, requestTimeoutMs: Math.max(transportOptions.requestTimeoutMs ?? 0, FACTORY_HOST_PREPARATION_CLIENT_TIMEOUT_MS) });
  // The last build's artifacts, for the commit that follows it: the role prepares one package at a time.
  let prepared: { readonly artifactDigest: string; readonly files: WorkspaceFiles } | undefined;
  return Object.freeze({
    async build(input) {
      let body: { result?: BuildResult; artifacts?: WorkspaceFiles };
      try {
        const response = await transport.request("POST", FACTORY_HOST_PREPARATION_PATH, { tenantId, operationId: input.operationId, sourceDigest: input.sourceDigest, files: input.files, entrypoint: input.entrypoint }, PREPARED_LIMIT_BYTES, new AbortController().signal);
        body = JSON.parse(response.body.toString("utf8")) as typeof body;
      } catch (error) {
        if (error instanceof GatewayStatusError) throw new FactoryHostLaunchRefusal(error.response);
        throw error;
      }
      const result = body?.result;
      if (!result || typeof result !== "object" || typeof result.state !== "string" || !body.artifacts || typeof body.artifacts !== "object") {
        throw new FactoryHostPreparationError("host_preparation_invalid", "the host's answer is not a build and its artifacts");
      }
      if (result.state === "succeeded") {
        if (typeof result.artifactDigest !== "string" || digestObject(body.artifacts) !== result.artifactDigest) {
          throw new FactoryHostPreparationError("host_preparation_artifact_mismatch", "the host's artifact files do not digest to the artifact it names");
        }
        prepared = { artifactDigest: result.artifactDigest, files: body.artifacts };
      }
      return result;
    },
    async collectArtifacts(artifactDigest) {
      if (prepared?.artifactDigest !== artifactDigest) throw new FactoryHostPreparationError("host_preparation_not_built", "this process has no prepared build of that artifact yet");
      return structuredClone(prepared.files);
    },
  });
}
