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
