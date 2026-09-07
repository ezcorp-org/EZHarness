/**
 * The API permits only admins to add or change instance providers. Keep the
 * client decision in one place so onboarding and chat never advertise a
 * control the server must refuse.
 */
export interface ProviderAccess {
	canConfigure: boolean;
	message: string;
}

export function providerAccess(role: string | undefined): ProviderAccess {
	if (role === "admin") {
		return {
			canConfigure: true,
			message: "Connect a provider to start chatting",
		};
	}

	return {
		canConfigure: false,
		message: "An administrator needs to connect a provider before you can chat",
	};
}
