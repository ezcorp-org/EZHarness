#!/usr/bin/env bun
/**
 * Testable pieces of scripts/verify-factory-archive-writer.ts's CLI surface:
 * its help text, the message printed when --restart-stores is omitted, and
 * the compose commands for the product-store-outage leg (which stops ONLY
 * factory-storage-ordinary, proves the archive answers independently and
 * that a release provider cannot verify a receipt while it is down, then
 * restarts it). Kept here (not inline in the script) so bun:test can
 * exercise every branch without spawning real S3/Compose processes or
 * requiring EZCORP_FACTORY_STORAGE_SECRETS_DIR — the script itself stays a
 * thin runner over these pure functions plus scripts/lib/container-engine.ts.
 * Argument parsing and compose-invocation shape are shared with
 * scripts/lib/verify-factory-storage-cli.ts via scripts/lib/factory-storage-cli.ts.
 */
import { type ComposeEnvInputs, type ComposeInvocation, parseRestartFlagArgs, RESTART_STORES_FLAG, type RestartFlagArgs, stopThenUpInvocations, UnknownArgumentError } from "./factory-storage-cli.ts";

export { RESTART_STORES_FLAG, UnknownArgumentError };
export type { ComposeInvocation };

export const HELP_TEXT = `Usage: bun scripts/verify-factory-archive-writer.ts [${RESTART_STORES_FLAG}]

Proves the archive-writer role against the real local SeaweedFS services for
all ten generated tenant identities: conditional create, checksum, version
reads, the archive inventory, and a refusal for every product and restore
attempt to read, overwrite, or delete an archive object. This part does not
touch any shared container's lifecycle (it still writes and reads real S3
objects in the generated tenant buckets).

  ${RESTART_STORES_FLAG}   Also run the product-store-outage leg, which proves the
                      archive keeps answering, and that a real release
                      provider cannot verify a receipt, while the product
                      store is down. This flag STOPS then RESTARTS the shared
                      factory-storage-ordinary store — coordinator-only on a
                      shared host, see docs/factory-local-storage.md. Without
                      this flag every other check still runs and this leg is
                      skipped; the written result's ordinaryStoreLoss records
                      { skipped: true } instead.

  -h, --help          Print this message and exit.

Requires EZCORP_FACTORY_STORAGE_SECRETS_DIR (see
scripts/setup-factory-storage.sh).`;

export const RESTART_LEG_SKIPPED_MESSAGE =
  `Product-store-outage leg skipped (pass ${RESTART_STORES_FLAG} to run it; that flag STOPS then RESTARTS the shared factory-storage-ordinary store — coordinator-only on a shared host, see docs/factory-local-storage.md).`;

export type VerifyFactoryArchiveWriterArgs = RestartFlagArgs;

/** Parses argv (no binary/script path entries — pass `Bun.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): VerifyFactoryArchiveWriterArgs {
  return parseRestartFlagArgs(argv, HELP_TEXT);
}

/** The one shared SeaweedFS service the product-store-outage leg stops and restarts. */
export const OUTAGE_LEG_SERVICES = ["factory-storage-ordinary"] as const;

/**
 * Builds the two `docker compose` invocations (stop, then up -d --wait) for
 * the product-store-outage leg, against ONLY factory-storage-ordinary — the
 * one store this leg takes down. `projectName` must match
 * scripts/setup-factory-storage.sh's `ezcorp-factory-storage-${UID}` so the
 * two tools address the same Compose project regardless of which resolved
 * the engine.
 */
export function outageLegInvocations(inputs: ComposeEnvInputs): readonly [ComposeInvocation, ComposeInvocation] {
  return stopThenUpInvocations(OUTAGE_LEG_SERVICES, inputs);
}
