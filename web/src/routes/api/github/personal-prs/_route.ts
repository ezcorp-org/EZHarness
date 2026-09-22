import { json } from "@sveltejs/kit";
import { PersonalPrError } from "$server/integrations/github-personal-prs/service";

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
	if (error instanceof SyntaxError || error instanceof Response && error.status === 413) {
		return json({ code: "invalid_input", error: "Invalid request" }, { status: 400, headers: { "cache-control": "no-store" } });
	}
	return json({ code: "unavailable", error: "Pull request service is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}
