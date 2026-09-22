import { json } from "@sveltejs/kit";
import { PersonalPrError } from "$server/integrations/github-personal-prs/service";
import { PrPublisherError } from "$server/integrations/github-personal-prs/publisher";
import { GithubUserError } from "$server/integrations/github-user/transport";

const statusByCode = {
	invalid_input: 400,
	not_found: 404,
	forbidden: 403,
	conflict: 409,
	unavailable: 503,
} as const;

export function personalPrRouteError(error: unknown): Response {
	if (error instanceof PersonalPrError) {
		return json({ code: error.code, error: error.message }, { status: statusByCode[error.code], headers: { "cache-control": "no-store" } });
	}
	if (error instanceof PrPublisherError) {
		const status = error.code === "invalid_input" ? 400 : error.code === "base_changed" || error.code === "remote_conflict" ? 409 : 502;
		const message = error.code === "base_changed" ? "The repository base changed. Start a new private import." : error.code === "remote_conflict" ? "GitHub reported a branch conflict. Start a new review." : error.code === "invalid_input" ? "Invalid pull request details" : "Could not verify the GitHub publication result";
		return json({ code: error.code, error: message }, { status, headers: { "cache-control": "no-store" } });
	}
	if (error instanceof GithubUserError) {
		return json({ code: "github_unavailable", error: "Could not reach GitHub" }, { status: 502, headers: { "cache-control": "no-store" } });
	}
	if (error instanceof SyntaxError || error instanceof Response && error.status === 413) {
		return json({ code: "invalid_input", error: "Invalid request" }, { status: 400, headers: { "cache-control": "no-store" } });
	}
	return json({ code: "unavailable", error: "Pull request service is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}
