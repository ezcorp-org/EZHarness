#!/usr/bin/env bun
/**
 * Records whether this deployment can run the reference code factory's pinned model.
 *
 * C10 pins `claude-haiku-4-5-20251001` on the Anthropic provider for both the native generator and
 * the separate supervised review validator. A deployment that cannot resolve that model or a
 * credential for it does not fall back: the run is a readiness failure, recorded by name, and the
 * remedy is a reviewed contract revision. This script produces that record, and it never reads,
 * prints, or writes a credential value — only which kind of credential resolved.
 */
import { writeFile } from "node:fs/promises";
import {
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  type FactoryProviderPin,
  type FactoryProviderReadiness,
} from "../src/providers/factory-broker.ts";

export const REFERENCE_CODE_MODEL_PIN: FactoryProviderPin = Object.freeze({
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
});

export async function runReferenceCodeProviderCheck(options: {
  readonly pin?: FactoryProviderPin;
  readonly evidencePath?: string;
  readonly log?: Pick<Console, "log">;
} = {}): Promise<number> {
  const pin = options.pin ?? REFERENCE_CODE_MODEL_PIN;
  const log = options.log ?? console;
  let readiness: FactoryProviderReadiness;
  try {
    readiness = await factoryProviderReadiness(pin);
  } catch (error) {
    // A configuration store that cannot be reached is itself a readiness failure, not a crash
    // and not a reason to substitute anything.
    readiness = {
      schemaVersion: "factory.provider-readiness.v1" as const,
      provider: pin.provider,
      model: pin.model,
      ready: false,
      credentialKind: null,
      failures: ["provider_not_configured" as const],
      checkedAtMs: Date.now(),
    };
    log.log(`provider configuration could not be read: ${(error as Error).name}`);
  }
  const record = { ...factoryProviderReadinessRecord(readiness), note: "Credential values are never read into this record." };
  log.log(JSON.stringify(record, null, 2));
  if (options.evidencePath) await writeFile(options.evidencePath, `${JSON.stringify(record, null, 2)}\n`);
  return readiness.ready ? 0 : 1;
}

function evidenceArgument(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--evidence");
  return index >= 0 ? argv[index + 1] : undefined;
}

export const REFERENCE_CODE_PROVIDER_MAIN_RESULT = import.meta.main
  ? await runReferenceCodeProviderCheck({ evidencePath: evidenceArgument(process.argv) })
  : undefined;
if (REFERENCE_CODE_PROVIDER_MAIN_RESULT !== undefined) process.exitCode = REFERENCE_CODE_PROVIDER_MAIN_RESULT;
