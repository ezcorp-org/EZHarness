/**
 * Logs the stack's administrator in over the real login route and saves the
 * session for the lane. No principal is manufactured: the stack created the
 * administrator through the first-run setup route, and this signs in as them.
 * The saved session is a live credential: the returned function, which
 * Playwright runs as the global teardown, removes it when the run ends.
 */
import { rm } from "node:fs/promises";
import { request } from "@playwright/test";
import { FACTORY_SERVICES_AUTH_PATH, readFactoryServicesState } from "./state.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
	const state = readFactoryServicesState();
	const context = await request.newContext({ baseURL: state.baseURL });
	try {
		const login = await context.post("/api/auth/login", { data: { email: state.admin.email, password: state.admin.password } });
		if (!login.ok()) throw new Error(`factory-services login failed (${login.status()}): ${await login.text()}`);
		const onboarded = await context.post("/api/onboarding/complete");
		if (![200, 204].includes(onboarded.status())) throw new Error(`factory-services onboarding failed (${onboarded.status()})`);
		await context.storageState({ path: FACTORY_SERVICES_AUTH_PATH });
	} finally {
		await context.dispose();
	}
	return async () => {
		await rm(FACTORY_SERVICES_AUTH_PATH, { force: true });
	};
}
