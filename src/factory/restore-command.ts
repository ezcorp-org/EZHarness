import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { composeFactoryInstallationRestore, factoryStartupConfigPath } from "./installation-startup";
import type { FactoryKeyCompositionDependencies } from "./key-management";
import { factoryRestoreReportDigest, type FactoryRestoreMode } from "./restore";
import { factoryAttestedRestoreFence } from "./restore-composition";
import { loadFactoryStartupConfig } from "./startup-config";

/**
 * The operator's restore command (C06, W15).
 *
 *   factory-restore begin  --restore-id <id> --fence <attestation.json> [--mode tenant|cluster] [--config <startup.json>]
 *   factory-restore verify --restore-id <id> --fence <attestation.json> [--config <startup.json>]
 *   factory-restore status --restore-id <id> [--config <startup.json>]
 *
 * `begin` opens the new execution epoch, runs every check, and prints the
 * recovery report's digest. `verify` runs every check again for that epoch
 * after an operator fixed a blocked finding. Both exit 2 while a
 * tenant-blocking check remains.
 * Service resumes only when a human administrator signs that exact digest in
 * the console (W14); this command never signs. It prints identifiers, counts,
 * and reasons only, never a credential or a record body.
 */

export const FACTORY_RESTORE_USAGE = "usage: factory-restore <begin|verify|status> --restore-id <id> [--fence <attestation.json>] [--mode tenant|cluster] [--config <startup.json>]";

export interface FactoryRestoreCommandIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  /** The product database the restore runs against. */
  readonly database: () => Promise<{ readonly db: TransactionalDb; close(): Promise<void> }>;
  readonly keys?: FactoryKeyCompositionDependencies;
  readonly compose?: typeof composeFactoryInstallationRestore;
}

function flags(argv: readonly string[]): Map<string, string> | null {
  const parsed = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1];
    if (!["--restore-id", "--fence", "--mode", "--config"].includes(name) || value === undefined || parsed.has(name)) return null;
    parsed.set(name, value);
  }
  return parsed;
}

export async function runFactoryRestoreCommand(argv: readonly string[], io: FactoryRestoreCommandIo): Promise<number> {
  const action = argv[0];
  const options = flags(argv);
  const restoreId = options?.get("--restore-id");
  const mode = (options?.get("--mode") ?? "tenant") as FactoryRestoreMode;
  const fencePath = options?.get("--fence");
  if (!options || !restoreId || !["begin", "verify", "status"].includes(action ?? "") || (action !== "status" && !fencePath) || (mode !== "tenant" && mode !== "cluster")) {
    io.out(FACTORY_RESTORE_USAGE);
    return 64;
  }
  const config = await loadFactoryStartupConfig(options.get("--config") ?? factoryStartupConfigPath(io.env));
  const opened = await io.database();
  try {
    if (action === "status") {
      const epoch = rows<{ state: string; report_digest: string | null; execution_epoch: string | number }>(await opened.db.execute(sql`SELECT state, report_digest, execution_epoch FROM factory_restore_epochs WHERE tenant_id = ${config.tenantId} AND restore_id = ${restoreId}`))[0];
      io.out(JSON.stringify(epoch ? { restoreId, state: epoch.state, executionEpoch: Number(epoch.execution_epoch), reportDigest: epoch.report_digest } : { restoreId, state: "not_found" }));
      return epoch ? 0 : 1;
    }
    const failures: string[] = [];
    const restore = await (io.compose ?? composeFactoryInstallationRestore)({
      config,
      host: {
        database: opened.db,
        // The restore replays projections through the run lifecycle's scope check only; no run is admitted.
        runOptions: { interpreterBuild: "factory-restore", interpreterCompatibility: "restore", limits: { maxCostMicros: "0", maxTokens: 0, maxComputeMs: 0 } },
        availableResourceClasses: [],
        report: part => { failures.push(part); },
      },
      fence: factoryAttestedRestoreFence(fencePath!),
      ...(io.keys === undefined ? {} : { keys: io.keys }),
    });
    const report = action === "begin" ? await restore.begin({ restoreId, mode }) : await restore.verify(await restore.resume(restoreId));
    io.out(JSON.stringify({
      restoreId, mode: report.mode, reportDigest: factoryRestoreReportDigest(report), executionEpoch: report.executionEpoch,
      blockedChecks: report.blockedChecks, blockedRuns: report.blockedRuns.length, releaseIdentities: report.releaseIdentities,
      uncomposed: failures,
      next: report.blockedChecks.length === 0 ? "a human administrator signs this report digest in the console" : "resolve every blocked check, then run verify",
    }));
    return report.blockedChecks.length === 0 ? 0 : 2;
  } finally {
    await opened.close();
  }
}
