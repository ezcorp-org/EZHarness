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
	recoveryAction?: "retry_pre_ref" | "check_github" | "reimport";
	reviewPath?: string;
};

export function personalPrReason(blockReason: string | undefined): string {
	switch (blockReason) {
		case "review_not_prepared": return "";
		case "run_not_successful": return "The run did not finish successfully. Complete a successful run before preparing a PR.";
		case "repository_not_enabled": return "Enable this repository for the GitHub App, then check access again.";
		case "insufficient_user_permission": return "Your GitHub account needs write access to this repository.";
		case "reconnect_required": return "Reconnect your GitHub account to continue.";
		case undefined: return "";
		default: return "This PR cannot continue. Check GitHub access or start a new review.";
	}
}

export function trustedGithubPrUrl(value: string | undefined): string | null {
	const trusted = trustedGithubUrl(value);
	if (!trusted) return null;
	const url = new URL(trusted);
	return !url.search && !url.hash && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) ? url.href : null;
}

export function trustedGithubUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
