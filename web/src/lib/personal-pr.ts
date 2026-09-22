export type PersonalPrView = {
	state: "working" | "ready" | "reviewing" | "creating" | "created" | "no_changes" | "blocked" | "stale" | "failed";
	proposalId?: string;
	digest?: string;
	repository?: { id: number; fullName: string; baseRef: string; baseSha: string };
	files?: {
		path: string;
		status: string;
		additions: number;
		deletions: number;
		patch?: string | null;
		binary?: boolean;
		beforeSha256?: string | null;
		afterSha256?: string | null;
		beforeBytes?: number | null;
		afterBytes?: number | null;
		beforeBase64?: string | null;
		afterBase64?: string | null;
	}[];
	checks?: { name: string; result: string }[];
	title?: string;
	body?: string;
	prUrl?: string;
	blockReason?: string;
	reviewPath?: string;
};

export function trustedGithubPrUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) ? url.href : null;
	} catch {
		return null;
	}
}
