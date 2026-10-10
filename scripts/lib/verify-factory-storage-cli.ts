#!/usr/bin/env bun
/**
 * Testable pieces of scripts/verify-factory-storage.ts's CLI surface: its
 * help text, the message printed when --restart-stores is omitted, and the
 * compose commands for the restart-persistence leg. Kept here (not inline in
 * the script) so bun:test can exercise every branch without spawning real
 * S3/Compose processes or requiring EZCORP_FACTORY_STORAGE_SECRETS_DIR — the
 * script itself stays a thin runner over these pure functions plus
 * scripts/lib/container-engine.ts. Argument parsing and compose-invocation
 * shape are shared with scripts/lib/verify-factory-archive-writer-cli.ts via
 * scripts/lib/factory-storage-cli.ts.
 */
import { type ComposeEnvInputs, type ComposeInvocation, parseRestartFlagArgs, RESTART_STORES_FLAG, type RestartFlagArgs, stopThenUpInvocations, UnknownArgumentError } from "./factory-storage-cli.ts";

export { RESTART_STORES_FLAG, UnknownArgumentError };
export type { ComposeInvocation };

export const HELP_TEXT = `Usage: bun scripts/verify-factory-storage.ts [${RESTART_STORES_FLAG}]

Verifies the local factory S3 conformance: ten tenant identities across the
ordinary and archive storage services, cross-tenant denials, conditional
writes, multipart uploads, and version reads. This part is read-only against
the shared stores.

  ${RESTART_STORES_FLAG}   Also run the restart-persistence leg, which proves an
                      object survives a service restart. This flag RESTARTS
                      BOTH shared SeaweedFS stores (factory-storage-ordinary
                      and factory-storage-archive) — coordinator-only on a
                      shared host, see docs/factory-local-storage.md. Without
                      this flag every other check still runs and the restart
                      leg is skipped.

  -h, --help          Print this message and exit.

Requires EZCORP_FACTORY_STORAGE_SECRETS_DIR (see
scripts/setup-factory-storage.sh).`;

export const RESTART_LEG_SKIPPED_MESSAGE =
  `Restart-persistence leg skipped (pass ${RESTART_STORES_FLAG} to run it; that flag RESTARTS BOTH shared SeaweedFS stores — coordinator-only on a shared host, see docs/factory-local-storage.md).`;

export type VerifyFactoryStorageArgs = RestartFlagArgs;

/** Parses argv (no binary/script path entries — pass `Bun.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): VerifyFactoryStorageArgs {
  return parseRestartFlagArgs(argv, HELP_TEXT);
}

/** Both shared SeaweedFS services the restart-persistence leg restarts. */
export const RESTART_LEG_SERVICES = ["factory-storage-ordinary", "factory-storage-archive"] as const;

/**
 * Builds the two `docker compose` invocations (stop, then up -d --wait)
 * for the restart-persistence leg, against BOTH shared stores. `projectName`
 * must match scripts/setup-factory-storage.sh's
 * `ezcorp-factory-storage-${UID}` so the two tools address the same Compose
 * project regardless of which resolved the engine.
 */
export function restartLegInvocations(inputs: ComposeEnvInputs): readonly [ComposeInvocation, ComposeInvocation] {
  return stopThenUpInvocations(RESTART_LEG_SERVICES, inputs);
}
