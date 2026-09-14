import { defineExtension, serve } from "@ezcorp/sdk/v4";
import { FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, type FactoryValidatorClaimReport } from "@ezcorp/factory-sdk/types";
import { referenceCodeStaticClaims } from "./static-claims";
import { REFERENCE_CODE_ADVISORY_SNAPSHOT, type ReferenceCodeAdvisorySnapshot } from "./scans";
import { referenceCodeChangedPaths, sealReferenceCodeSnapshot, type ReferenceCodeFile } from "./snapshot";

/**
 * The reference code validator, as it runs inside one isolated guest.
 *
 * This is the same code the host runs, bundled and shipped into a Podman sandbox with no network,
 * no writable root, and no grants. It computes the four claims that need only the candidate's own
 * bytes — the advisory scan, the secret scan, the allowed paths, and the protected assets — and
 * reports them through the broker as a strict `factory.validator-claims.v1` payload.
 *
 * It carries no provenance and mints none. The gateway seals that from the durable assignment row;
 * a guest that could sign its own trust would be the whole point of the isolation, undone.
 *
 * The five claims that run the repository's build, typecheck, and test scripts are not here. They
 * need a toolchain and a resolved dependency set, which the pinned validator image supplies in its
 * own lane; putting them in this guest would mean shipping a package manager into the sandbox that
 * reads the candidate's own manifest.
 */

export const REFERENCE_CODE_GUEST_SCHEMA_VERSION = "factory.reference-code-guest.v1" as const;
export const REFERENCE_CODE_GUEST_TOOL = "protectedChecks";

export interface ReferenceCodeGuestFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly contentBase64: string;
}

export interface ReferenceCodeGuestInput {
  readonly schemaVersion: typeof REFERENCE_CODE_GUEST_SCHEMA_VERSION;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly snapshotFiles: readonly ReferenceCodeGuestFile[];
  readonly candidateFiles: readonly ReferenceCodeGuestFile[];
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly advisories?: ReferenceCodeAdvisorySnapshot;
  readonly measuredAtMs: number;
}

function decode(files: readonly ReferenceCodeGuestFile[]): readonly ReferenceCodeFile[] {
  return files.map(file => ({ path: file.path, mode: file.mode, content: new Uint8Array(Buffer.from(file.contentBase64, "base64")) }));
}

/** One strict claim report from one guest payload, with every failure reported as a claim. */
export function referenceCodeGuestReport(value: unknown): FactoryValidatorClaimReport {
  const input = value as ReferenceCodeGuestInput;
  if (!input || typeof input !== "object" || input.schemaVersion !== REFERENCE_CODE_GUEST_SCHEMA_VERSION) {
    return {
      schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION,
      claims: [{ id: "dependency-advisory", verdict: "VALIDATOR_ERROR", decisive: false, summary: "The guest was handed a payload it does not recognize.", reasonCode: "guest_input_invalid", evidence: [], measuredAtMs: 0 }],
      error: { code: "guest_input_invalid", message: "The guest was handed a payload it does not recognize." },
    };
  }
  const snapshot = sealReferenceCodeSnapshot({
    baseSha: input.baseSha,
    treeSha: input.treeSha,
    entries: decode(input.snapshotFiles).map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
  });
  const files = decode(input.candidateFiles);
  const statics = referenceCodeStaticClaims({
    changedPaths: referenceCodeChangedPaths(snapshot.files, files),
    snapshot,
    files,
    allowedPaths: input.allowedPaths,
    protectedPaths: input.protectedPaths,
    advisories: input.advisories ?? REFERENCE_CODE_ADVISORY_SNAPSHOT,
    measuredAtMs: input.measuredAtMs,
  });
  return { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: statics.claims };
}

export const REFERENCE_CODE_GUEST_MANIFEST = {
  schemaVersion: 4 as const,
  name: "reference-code-validator",
  version: "1.0.0",
  author: { name: "EZCorp Factory" },
  description: "The reference code factory's protected static claims, in one isolated guest.",
  permissions: {},
  tools: [{ name: REFERENCE_CODE_GUEST_TOOL, description: "Reports the reference code contract's static protected claims.", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
};

/**
 * The tool the host invokes, named rather than inlined so a test can drive it directly.
 *
 * It reports claims and returns a result that carries none. Turning a report into durable evidence
 * is the gateway's job; a guest that could do it would be signing its own trust.
 */
export async function referenceCodeGuestTool(
  input: unknown,
  context: { call(method: string, value: unknown): Promise<unknown> },
): Promise<Record<string, unknown>> {
  const request = input as { input?: { kind?: string; value?: unknown } };
  const report = referenceCodeGuestReport(request?.input?.value);
  await context.call("factory.broker", { kind: "validator-report", report });
  return { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] };
}

export const REFERENCE_CODE_GUEST_EXTENSION = defineExtension({
  manifest: REFERENCE_CODE_GUEST_MANIFEST,
  tools: { [REFERENCE_CODE_GUEST_TOOL]: referenceCodeGuestTool },
});

/** Serving happens only when this module IS the guest process, never when a test imports it. */
export const REFERENCE_CODE_GUEST_SERVED = import.meta.main ? await serve(REFERENCE_CODE_GUEST_EXTENSION) : undefined;
