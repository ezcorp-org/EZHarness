import { writable } from "svelte/store";

export interface ConnectionInfo {
	state: "connected" | "disconnected" | "reconnecting" | "failed";
	attempt: number;
	maxAttempts: number;
}

export const connectionState = writable<ConnectionInfo>({
	state: "connected",
	attempt: 0,
	maxAttempts: 10,
});
