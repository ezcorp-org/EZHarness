// SSRF guard for user-supplied URLs. Used by the /api/providers/local/*
// routes (and any future route that accepts an arbitrary baseUrl from the
// request body).
//
// Two layers:
//   1. isPrivateOrLoopback() — synchronous, literal-hostname check. Fast
//      path for obvious IP literals and loopback aliases.
//   2. resolveAndValidateHostname() — async DNS lookup that re-checks
//      every resolved address against isPrivateOrLoopback(). Closes the
//      DNS-rebinding window where "evil.example" → 127.0.0.1.
//
// Plus ONE deliberate carve-out, `checkLocalProviderTarget()` — see its
// doc block. It is opt-in per call site: `isPrivateOrLoopback()` itself is
// unchanged, so a future route that reaches for the general guard keeps the
// strict sec-H1 posture with no carve-out at all.

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const LOOPBACK_HOSTNAMES = new Set([
	"localhost",
	"ip6-localhost",
	"ip6-loopback",
]);

function isPrivateIPv4(octets: number[]): boolean {
	const [a, b] = octets;
	if (a === undefined || b === undefined) return true;
	if (a === 0) return true; // 0.0.0.0/8 — "this network"
	if (a === 127) return true; // 127.0.0.0/8 — loopback
	if (a === 10) return true; // 10.0.0.0/8 — private
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (cloud metadata)
	return false;
}

/**
 * Expand a (possibly-compressed) IPv6 address into 8 16-bit integers.
 * Returns null if the address cannot be parsed as IPv6.
 */
function expandIPv6(addr: string): number[] | null {
	// Support embedded dotted-quad IPv4 form (e.g. ::ffff:127.0.0.1).
	let source = addr;
	const lastColon = source.lastIndexOf(":");
	if (lastColon >= 0 && source.indexOf(".", lastColon) > 0) {
		const tail = source.slice(lastColon + 1);
		const head = source.slice(0, lastColon + 1);
		if (isIP(tail) !== 4) return null;
		const octets = tail.split(".").map(Number);
		const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
		const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
		source = `${head}${hi}:${lo}`;
	}

	const parts = source.split("::");
	if (parts.length > 2) return null;

	const head = parts[0] === "" ? [] : parts[0]!.split(":");
	const tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1]!.split(":")) : [];
	const fillCount = 8 - head.length - tail.length;
	if (fillCount < 0) return null;
	if (parts.length === 1 && fillCount !== 0) return null;

	const filled = [
		...head,
		...new Array<string>(fillCount).fill("0"),
		...tail,
	];
	if (filled.length !== 8) return null;

	const values: number[] = [];
	for (const group of filled) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		values.push(parseInt(group, 16));
	}
	return values;
}

function isPrivateIPv6(addr: string): boolean {
	const groups = expandIPv6(addr.toLowerCase());
	if (!groups) return true; // unparseable — fail closed
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number, number, number, number, number, number, number, number
	];

	// :: (all zeros) and ::1
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
		return g7 === 0 || g7 === 1;
	}

	// IPv4-mapped IPv6: ::ffff:a.b.c.d — first 5 groups zero, 6th is ffff,
	// last 32 bits encode the IPv4. Apply the IPv4 private-range rules.
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
		const v4 = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
		return isPrivateIPv4(v4);
	}

	// fc00::/7 — unique local addresses. First 7 bits are 1111110.
	if ((g0 & 0xfe00) === 0xfc00) return true;

	// fe80::/10 — link-local. First 10 bits are 1111111010.
	if ((g0 & 0xffc0) === 0xfe80) return true;

	return false;
}

/**
 * Return true if the given hostname targets a loopback, private, link-local,
 * or otherwise non-routable address. Callers should reject the request when
 * this returns true.
 *
 * - Literal "localhost" and other loopback aliases
 * - IPv4: 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16
 * - IPv6: ::1, ::, fc00::/7, fe80::/10, and IPv4-mapped equivalents
 *
 * Non-IP hostnames (e.g. "foo.example") are NOT automatically rejected —
 * the caller is responsible for any additional allowlist/DNS pinning.
 */
export function isPrivateOrLoopback(hostname: string): boolean {
	if (!hostname) return true;
	let lower = hostname.toLowerCase();
	// URL parsers wrap IPv6 literals in brackets: "[::1]". Strip them.
	if (lower.startsWith("[") && lower.endsWith("]")) {
		lower = lower.slice(1, -1);
	}
	if (LOOPBACK_HOSTNAMES.has(lower)) return true;
	const version = isIP(lower);
	if (version === 4) {
		return isPrivateIPv4(lower.split(".").map(Number));
	}
	if (version === 6) {
		return isPrivateIPv6(lower);
	}
	return false;
}

/**
 * True when `hostname` is a LITERAL spelling of the loopback interface — the
 * machine EZCorp itself runs on, and nothing else.
 *
 * Deliberately a strict subset of {@link isPrivateOrLoopback}:
 *   ALLOWED  "localhost" / "ip6-localhost" / "ip6-loopback", 127.0.0.0/8,
 *            ::1, and ::ffff:127.0.0.0/8 (the IPv4-mapped spelling of the
 *            same interface).
 *   REFUSED  everything else it blocks — 10/8, 172.16/12, 192.168/16,
 *            169.254/16 (cloud metadata), 0.0.0.0/8, ::, fc00::/7, fe80::/10
 *            — plus every non-IP hostname, INCLUDING one whose DNS record
 *            points at 127.0.0.1. Rebinding is a resolution-time attack; a
 *            literal is not resolved, so only literals qualify.
 */
export function isLoopbackLiteral(hostname: string): boolean {
	if (!hostname) return false;
	let lower = hostname.toLowerCase();
	if (lower.startsWith("[") && lower.endsWith("]")) {
		lower = lower.slice(1, -1);
	}
	if (LOOPBACK_HOSTNAMES.has(lower)) return true;
	const version = isIP(lower);
	if (version === 4) return lower.split(".")[0] === "127";
	if (version === 6) {
		const groups = expandIPv6(lower);
		if (!groups) return false;
		const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
			number, number, number, number, number, number, number, number
		];
		// ::1 — the IPv6 loopback. `::` (all-zero, "unspecified") is NOT it.
		if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
			return g7 === 1;
		}
		// ::ffff:127.a.b.c — IPv4-mapped loopback, same interface.
		if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
			return ((g6 >> 8) & 0xff) === 127;
		}
	}
	return false;
}

/**
 * Env kill-switch restoring the pre-carve-out posture: with it set, the
 * local-provider routes refuse loopback exactly as they did before, and
 * `checkLocalProviderTarget` becomes byte-identical to the sec-H1 fix.
 *
 * For deployments where "the host EZCorp runs on" is NOT the admin's own box
 * (shared/hosted EZCorp), an operator flips this and the carve-out is gone.
 */
export const BLOCK_LOOPBACK_ENV = "EZCORP_BLOCK_LOOPBACK_PROVIDERS";

/** True when {@link BLOCK_LOOPBACK_ENV} is set to `1` or `true` (any case). */
export function loopbackProvidersBlocked(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env[BLOCK_LOOPBACK_ENV];
	if (raw === undefined) return false;
	const lower = raw.trim().toLowerCase();
	return lower === "1" || lower === "true";
}

/** {@link checkLocalProviderTarget}'s verdict: proceed, or the 400 to return. */
export type LocalProviderTargetCheck = { ok: true } | { ok: false; error: string };

/**
 * The full SSRF decision for a user-supplied local-provider `baseUrl`, shared
 * verbatim by POST /api/providers/local/models and POST /api/providers/local/test
 * (they had 20 duplicated lines of it each).
 *
 * ── The loopback carve-out, and exactly how narrow it is ──
 * Self-hosted local inference is a supported deployment: the settings UI
 * auto-fills `http://localhost:11434` (Ollama's default) in three places, and
 * the sec-H1 guard then refused the server's own suggestion, so a local Ollama
 * could not be registered through the UI at all.
 *
 * So a LITERAL loopback host is accepted here — and nothing else changes:
 *   • Address space: {@link isLoopbackLiteral} only, a strict subset of
 *     {@link isPrivateOrLoopback}. Every private range, link-local (cloud
 *     metadata), ULA and 0/8 target is still refused with the same 400.
 *   • Rebinding: a literal is not resolved, so a hostname whose A record is
 *     127.0.0.1 does NOT qualify — it falls through to the DNS pin below and
 *     is still refused. The rebinding defense is untouched.
 *   • Principal: unchanged. Both routes still require the admin ROLE and the
 *     admin api-key SCOPE before this function is ever called.
 *   • Blast radius: this function, and only this function. `isPrivateOrLoopback`
 *     is unmodified, so every other (and future) consumer of the guard is
 *     unaffected.
 *   • Reversible: {@link BLOCK_LOOPBACK_ENV} restores the old behaviour.
 *
 * Residual risk accepted: an EZCorp admin can make the server probe loopback
 * ports on its own host. That principal can already run host code through the
 * extension/tool surface, so the carve-out grants no reach they lacked — which
 * is precisely why it stops at loopback and does not extend one bit further.
 */
export async function checkLocalProviderTarget(
	baseUrl: string,
): Promise<LocalProviderTargetCheck> {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return { ok: false, error: "Invalid baseUrl" };
	}

	if (isLoopbackLiteral(parsed.hostname) && !loopbackProvidersBlocked()) {
		return { ok: true };
	}

	// sec-H1: reject loopback/private/link-local targets to block SSRF
	// against cloud metadata, local Redis/Postgres, internal k8s services, etc.
	if (isPrivateOrLoopback(parsed.hostname)) {
		return { ok: false, error: "baseUrl targets a private or loopback address" };
	}

	// sec-H1 DNS pinning: resolve the hostname and re-check every A/AAAA
	// address. Blocks the rebinding case where "evil.example" → 127.0.0.1
	// via attacker-controlled DNS. `lookup` throws for NXDOMAIN; treat any
	// resolution failure as a block rather than leaking the error.
	try {
		const dnsCheck = await resolveAndValidateHostname(parsed.hostname);
		if (!dnsCheck.ok) {
			return {
				ok: false,
				error: dnsCheck.reason ?? "baseUrl targets a private or loopback address",
			};
		}
	} catch {
		return { ok: false, error: "hostname could not be resolved" };
	}

	return { ok: true };
}

/**
 * DNS-pinning check: resolve `hostname` to every A/AAAA address the OS
 * would use and re-run each through `isPrivateOrLoopback`. Catches the
 * DNS-rebinding case where a hostname like "evil.example" has an A
 * record pointing at 127.0.0.1 (or an attacker-controlled nameserver
 * that flips responses between validation and fetch).
 *
 * Throws on NXDOMAIN / other lookup errors — callers should wrap in
 * try/catch and treat a throw as "block this request".
 *
 * Returns `{ ok: false }` if any resolved address is private/loopback,
 * or if the lookup returned zero addresses.
 */
export async function resolveAndValidateHostname(
	hostname: string,
): Promise<{ ok: boolean; reason?: string }> {
	const addrs = await dnsLookup(hostname, { all: true });
	if (!Array.isArray(addrs) || addrs.length === 0) {
		return { ok: false, reason: "hostname could not be resolved" };
	}
	for (const entry of addrs) {
		if (isPrivateOrLoopback(entry.address)) {
			return { ok: false, reason: "hostname resolves to private/loopback" };
		}
	}
	return { ok: true };
}
