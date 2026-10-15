#!/usr/bin/env bun
/**
 * Records whether this deployment can run the reference code factory's pinned model.
 *
 * C10 pins `gpt-6-luna` on the OpenAI provider for both the native generator and the separate
 * supervised review validator (reviewed revision W10c, 2026-10-03: served by the ChatGPT-plan OAuth
 * login through the subscription endpoint; it replaced `claude-haiku-4-5-20251001`). A deployment that
 * cannot resolve that model or a credential for it does not fall back: the run is a readiness
 * failure, recorded by name, and the remedy is a reviewed contract revision. This script produces
 * that record, and it never reads, prints, or writes a credential value — only which kind of
 * credential resolved.
 *
 * It reads the deployment it runs in: the database and secrets the environment names
 * (DATABASE_URL or EZCORP_DB_PATH, and the encryption settings), the same ones the started
 * application reads. It never falls back to a default: with no store named it stops by name
 * (`store_not_named`) and opens nothing, so it cannot create a database or a key under HOME or
 * the checkout. The record names the store's KIND and whether it opened, never a path or a URL.
 */
import { writeFile } from "node:fs/promises";
import { referenceModelPin } from "@ezcorp/factory-sdk";
import { closeDb, initDb } from "../src/db/connection.ts";
import { getSetting } from "../src/db/queries/settings.ts";
import {
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  type FactoryProviderPin,
  type FactoryProviderReadiness,
  type FactoryProviderReadinessFailure,
} from "../src/providers/factory-broker.ts";

/** The C10 pin, read from the reference definitions' own module rather than restated here. */
export const REFERENCE_CODE_MODEL_PIN: FactoryProviderPin = referenceModelPin;

type Environment = Readonly<Record<string, string | undefined>>;

/** What kind of configuration store the environment names, or null when it names none. */
export type DeploymentStoreKind = "postgres" | "pglite-file" | "pglite-memory";

/**
 * The store the environment names, judged before anything is opened.
 *
 * The application's own defaults (a PGlite under HOME, an encryption key generated beside the
 * database or in the working folder) are right for the application and wrong for a probe: a
 * probe that falls back to them creates an empty deployment and reports on it. So a store is
 * named by DATABASE_URL or EZCORP_DB_PATH, and a store whose folder does not hold the keys
 * (PostgreSQL, `:memory:`) must also name them (EZCORP_ENCRYPTION_SECRET or EZCORP_SECRETS_DIR).
 */
export function deploymentStoreKind(env: Environment = process.env): DeploymentStoreKind | null {
  const kind: DeploymentStoreKind | null = env.DATABASE_URL ? "postgres" : env.EZCORP_DB_PATH === ":memory:" ? "pglite-memory" : env.EZCORP_DB_PATH ? "pglite-file" : null;
  if (kind === null || kind === "pglite-file") return kind;
  return env.EZCORP_ENCRYPTION_SECRET || env.EZCORP_SECRETS_DIR ? kind : null;
}

export class DeploymentStoreNotNamedError extends Error {
  constructor() {
    super("no configuration store is named: set DATABASE_URL or EZCORP_DB_PATH (and, for PostgreSQL or :memory:, EZCORP_ENCRYPTION_SECRET or EZCORP_SECRETS_DIR)");
    this.name = "DeploymentStoreNotNamedError";
  }
}

/**
 * Runs `work` with the deployment's own configuration store open. Without it every credential
 * lookup fails, and a signed-in deployment reads "not configured" (W10c R1). The reference code
 * journey uses the same helper, so the two commands read the same deployment.
 */
export async function withDeploymentStore<T>(work: () => Promise<T>, env: Environment = process.env): Promise<T> {
  if (deploymentStoreKind(env) === null) throw new DeploymentStoreNotNamedError();
  try {
    await initDb();
    return await work();
  } finally {
    await closeDb();
  }
}

type ProbeFailure = FactoryProviderReadinessFailure | "store_not_named" | "store_unavailable";

export async function runReferenceCodeProviderCheck(options: {
  readonly pin?: FactoryProviderPin;
  readonly evidencePath?: string;
  readonly log?: Pick<Console, "log">;
  /** The environment that names the store. The connection itself reads process.env. */
  readonly env?: Environment;
} = {}): Promise<number> {
  const pin = options.pin ?? REFERENCE_CODE_MODEL_PIN;
  const log = options.log ?? console;
  const env = options.env ?? process.env;
  let opened = false;
  let readiness: FactoryProviderReadiness;
  let storeFailure: ProbeFailure | undefined;
  try {
    readiness = await withDeploymentStore(async () => {
      opened = true;
      // The credential lookup turns every store error into "no credential". Read the store once
      // first, so a broken store is named as one instead of hiding behind a missing login.
      await getSetting(`provider:accessMode:${pin.provider}`);
      return factoryProviderReadiness(pin);
    }, env);
  } catch (error) {
    // A store that is not named or cannot be read is itself a readiness failure, named as such:
    // not a crash, not a missing credential, and not a reason to substitute anything. Only the
    // error's NAME is logged; its message can carry a path or a connection URL.
    storeFailure = error instanceof DeploymentStoreNotNamedError ? "store_not_named" : "store_unavailable";
    if (storeFailure === "store_unavailable") opened = false;
    log.log(`provider configuration could not be read: ${(error as Error).name} (${storeFailure})`);
    readiness = {
      schemaVersion: "factory.provider-readiness.v1" as const,
      provider: pin.provider,
      model: pin.model,
      ready: false,
      credentialKind: null,
      failures: [],
      checkedAtMs: Date.now(),
    };
  }
  const base = factoryProviderReadinessRecord(readiness);
  const record = {
    ...base,
    failures: storeFailure === undefined ? base.failures : [storeFailure],
    store: { kind: deploymentStoreKind(env), opened },
    note: "Credential values are never read into this record.",
  };
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
