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
	readonly prepared: boolean;
}

export const FACTORY_SERVICES_STATE_PATH = process.env.FACTORY_SERVICES_STATE
	?? join(dirname(fileURLToPath(import.meta.url)), "..", ".factory-services-state.json");
export const FACTORY_SERVICES_AUTH_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".factory-services-auth.json");

export function readFactoryServicesState(): FactoryServicesState {
	return JSON.parse(readFileSync(FACTORY_SERVICES_STATE_PATH, "utf8")) as FactoryServicesState;
}
