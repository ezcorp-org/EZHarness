/**
 * The held real stack, as `stack.ts` publishes it for the `factory-services`
 * lane: where the application listens, the administrator it set up, the two
 * projects, and the guest runner package it built. Every journey reads this
 * rather than re-deriving a fact the stack already owns.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FactoryServicesState {
	readonly baseURL: string;
	readonly admin: { readonly name: string; readonly email: string; readonly password: string };
	readonly adminId: string;
	readonly tenantId: string;
	readonly installationId: string;
	readonly projectId: string;
	readonly readerProjectId: string;
	readonly consoleFactoryId: string;
	readonly definitionPath: string;
	readonly guest: {
		readonly reference: { readonly package: string; readonly manifestName: string; readonly version: string; readonly digest: string; readonly export: string };
		readonly installationId: string;
		readonly releaseId: string;
	};
	/** The acceptance claim's validator: the guest reference pinned with its configuration digest. */
	readonly validatorReference: FactoryServicesState["guest"]["reference"] & { readonly configurationDigest: string };
	/** The console definition's acceptance contract. */
	readonly contractId: string;
	/** Where the console definition's release node publishes, under the declared destination's prefix. */
	readonly releaseObject: string;
	/** True once the guest and its validator reference are both prepared. */
	readonly prepared: boolean;
	/** Set once the stack has rewritten the draft a journey asked for. */
	readonly futureDraftId?: string;
	/** Set once the stack has opened the restore epoch a journey asked for. */
	readonly restoreId?: string;
	/** The digest `factory-restore begin` printed for that restore's report. */
	readonly restoreReportDigest?: string;
	/** The operator command's exit status: 0 signable, 2 blocked, anything else failed (see its log). */
	readonly restoreExit?: number;
	/** The tenant-blocking checks that report names; a report with any cannot be signed. */
	readonly restoreBlockedChecks?: readonly string[];
}

export const FACTORY_SERVICES_STATE_PATH = process.env.FACTORY_SERVICES_STATE
	?? join(dirname(fileURLToPath(import.meta.url)), "..", ".factory-services-state.json");
/**
 * A journey writes a draft's factory id to this file to ask the stack to rewrite
 * that draft's stored source as a newer server would (schema version `factory.v9`).
 */
export const FACTORY_SERVICES_FUTURE_DRAFT_REQUEST_PATH = `${FACTORY_SERVICES_STATE_PATH}.future-draft-request`;
/** The event cursor lifetime the stack gives the application, so the lane can observe a 410. */
export const FACTORY_SERVICES_CURSOR_TTL_MS = 120_000;
/** A journey creates this file to ask the stack to run one restore through the operator command. */
export const FACTORY_SERVICES_RESTORE_REQUEST_PATH = `${FACTORY_SERVICES_STATE_PATH}.restore-request`;
export const FACTORY_SERVICES_AUTH_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".factory-services-auth.json");

export function readFactoryServicesState(): FactoryServicesState {
	return JSON.parse(readFileSync(FACTORY_SERVICES_STATE_PATH, "utf8")) as FactoryServicesState;
}
