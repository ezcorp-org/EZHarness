import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireRole } from "$server/auth/middleware";
import { listModels } from "$server/providers/local-model-check";
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
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const { baseUrl } = body as { baseUrl?: string };

	if (!baseUrl || typeof baseUrl !== "string") {
		return json({ error: "baseUrl is required" }, { status: 400 });
	}
	if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
		return json({ error: "baseUrl must start with http:// or https://" }, { status: 400 });
	}

	// sec-H1: reject loopback/private/link-local targets to block SSRF
	// against cloud metadata, local Redis/Postgres, internal k8s services, etc.
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return json({ error: "Invalid baseUrl" }, { status: 400 });
	}
	if (isPrivateOrLoopback(parsed.hostname)) {
		return json(
			{ error: "baseUrl targets a private or loopback address" },
			{ status: 400 },
		);
	}

	// sec-H1 DNS pinning: resolve the hostname and re-check every A/AAAA
	// address. Blocks the rebinding case where "evil.example" → 127.0.0.1
	// via attacker-controlled DNS. `lookup` throws for NXDOMAIN; treat any
	// resolution failure as a block rather than leaking the error.
	try {
		const dnsCheck = await resolveAndValidateHostname(parsed.hostname);
		if (!dnsCheck.ok) {
			return json(
				{ error: dnsCheck.reason ?? "baseUrl targets a private or loopback address" },
				{ status: 400 },
			);
		}
	} catch {
		return json(
			{ error: "hostname could not be resolved" },
			{ status: 400 },
		);
	}

	try {
		const result = await listModels(baseUrl);
		return json(result);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};
