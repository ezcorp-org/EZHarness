import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { requireRole } from "$server/auth/middleware";
import { checkLocalModel } from "$server/providers/local-model-check";
import {
	isPrivateOrLoopback,
	resolveAndValidateHostname,
} from "$lib/server/security/url-validation";

export const POST: RequestHandler = async ({ request, locals }) => {
	// sec-H1: admin role required. Pre-fix this route was only gated by
	// requireScope(locals, "admin") which is a no-op for cookie auth, so any
	// authenticated member could drive server-side fetch() to arbitrary URLs
	// (cloud metadata, internal services, …) — SSRF.
	requireRole(locals, "admin");

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return errorJson(400, "Invalid JSON body");
	}

	const { baseUrl, modelId } = body as { baseUrl?: string; modelId?: string };

	if (!baseUrl || typeof baseUrl !== "string") {
		return errorJson(400, "baseUrl is required");
	}
	if (!modelId || typeof modelId !== "string") {
		return errorJson(400, "modelId is required");
	}
	if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
		return errorJson(400, "baseUrl must start with http:// or https://");
	}

	// sec-H1: reject loopback/private/link-local targets to block SSRF
	// against cloud metadata, local Redis/Postgres, internal k8s services, etc.
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return errorJson(400, "Invalid baseUrl");
	}
	if (isPrivateOrLoopback(parsed.hostname)) {
		return errorJson(400, "baseUrl targets a private or loopback address");
	}

	// sec-H1 DNS pinning: resolve the hostname and re-check every A/AAAA
	// address. Blocks the rebinding case where "evil.example" → 127.0.0.1
	// via attacker-controlled DNS. `lookup` throws for NXDOMAIN; treat any
	// resolution failure as a block rather than leaking the error.
	try {
		const dnsCheck = await resolveAndValidateHostname(parsed.hostname);
		if (!dnsCheck.ok) {
			return errorJson(400, dnsCheck.reason ?? "baseUrl targets a private or loopback address");
		}
	} catch {
		return errorJson(400, "hostname could not be resolved");
	}

	try {
		const result = await checkLocalModel(baseUrl, modelId);
		return json(result);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return errorJson(500, message);
	}
};
