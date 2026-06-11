/**
 * Client-side admin gate for `/settings/admin*` pages (locked decision 1):
 * resolves the current user and returns it only when they are an admin;
 * returns null for anonymous / member users so the caller can redirect
 * to the default settings route. Pure fetch logic — testable without Svelte.
 */
export interface CurrentUser {
	id: string;
	email: string;
	name: string;
	role: "admin" | "member";
}

export async function requireAdmin(): Promise<CurrentUser | null> {
	try {
		const res = await fetch("/api/auth/me");
		if (!res.ok) return null;
		const data = await res.json();
		const user = data?.user as CurrentUser | undefined;
		return user?.role === "admin" ? user : null;
	} catch {
		return null;
	}
}
