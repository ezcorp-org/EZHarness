#!/usr/bin/env bun
/**
 * Records whether this deployment can run the reference code factory's pinned model.
 *
 * C10 pins `gpt-5.6-luna` on the OpenAI provider for both the native generator and the separate
 * supervised review validator (reviewed revision W10c, 2026-10-03: served by the ChatGPT-plan OAuth
 * login through the subscription endpoint; it replaced `claude-haiku-4-5-20251001`). A deployment that
 * cannot resolve that model or a credential for it does not fall back: the run is a readiness
 * failure, recorded by name, and the remedy is a reviewed contract revision. This script produces
 * that record, and it never reads, prints, or writes a credential value — only which kind of
 * credential resolved.
 *
 * It reads the deployment it runs in: the database and secrets the environment names
 * (DATABASE_URL or EZCORP_DB_PATH, and the encryption settings), the same ones the started
 * application reads.
 */
import { writeFile } from "node:fs/promises";
import { closeDb, initDb } from "../src/db/connection.ts";
import {
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  type FactoryProviderPin,
  type FactoryProviderReadiness,
} from "../src/providers/factory-broker.ts";

export const REFERENCE_CODE_MODEL_PIN: FactoryProviderPin = Object.freeze({
  provider: "openai",
  model: "gpt-5.6-luna",
});

/**
 * Runs `work` with the deployment's own configuration store open. Without it every credential
 * lookup fails, and a signed-in deployment reads "not configured" (W10c R1). The reference code
 * journey uses the same helper, so the two commands read the same deployment.
 */
export async function withDeploymentStore<T>(work: () => Promise<T>): Promise<T> {
  try {
    await initDb();
    return await work();
  } finally {
    await closeDb();
  }
}

export async function runReferenceCodeProviderCheck(options: {
  readonly pin?: FactoryProviderPin;
  readonly evidencePath?: string;
  readonly log?: Pick<Console, "log">;
} = {}): Promise<number> {
  const pin = options.pin ?? REFERENCE_CODE_MODEL_PIN;
  const log = options.log ?? console;
  let readiness: FactoryProviderReadiness;
  try {
    readiness = await withDeploymentStore(() => factoryProviderReadiness(pin));
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
