/**
 * The legacy-adoption proof pins the pgvector asset it carries into the legacy image
 * (`scripts/legacy-adoption-vector-asset.pin`). A pglite-pgvector bump that leaves that pin behind used to surface only
 * 35 minutes into the production proof, as "Candidate vector asset checksum mismatch". This fails at once instead:
 * the pin must name the package version and tarball integrity that both lockfiles resolve, and it must be the ONLY
 * place the asset checksum lives.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PIN = "scripts/legacy-adoption-vector-asset.pin";
const CONSUMERS = ["scripts/verify-legacy-adoption.sh", "scripts/Dockerfile.legacy-adoption-derived"];

/** The `key=value` lines of a pin file; comment and blank lines are skipped. */
function parsePin(text: string): Record<string, string> {
	const pin: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = line.match(/^([a-z0-9_]+)=(.+)$/);
		if (match) pin[match[1]] = match[2].trim();
	}
	return pin;
}

/** The version and integrity a bun.lock resolves for `name`, or null when it does not list the package. */
function lockedPackage(lock: string, name: string): { version: string; integrity: string } | null {
	const escaped = name.replace(/[/@.-]/g, (char) => `\\${char}`);
	const match = lock.match(new RegExp(`"${escaped}": \\["${escaped}@([^"]+)", "[^"]*", \\{[^\\n]*?"(sha512-[^"]+)"\\]`));
	return match ? { version: match[1], integrity: match[2] } : null;
}

const read = (path: string) => Bun.file(join(ROOT, path)).text();

describe("parsePin and lockedPackage", () => {
	test("read a pin and a bun.lock package line", () => {
		expect(parsePin("# note\npackage=@a/b\nversion=1.2.3\n\nasset_sha256=ab")).toEqual({ package: "@a/b", version: "1.2.3", asset_sha256: "ab" });
		const lock = '    "@a/b": ["@a/b@1.2.3", "", { "peerDependencies": { "c": "1" } }, "sha512-xyz=="],\n';
		expect(lockedPackage(lock, "@a/b")).toEqual({ version: "1.2.3", integrity: "sha512-xyz==" });
		expect(lockedPackage(lock, "@a/c")).toBeNull();
	});
});

describe("the legacy-adoption vector asset pin", () => {
	test("names the pglite-pgvector version and tarball integrity both lockfiles resolve", async () => {
		const pin = parsePin(await read(PIN));
		expect(pin.package).toBe("@electric-sql/pglite-pgvector");
		expect(pin.asset).toBe("dist/vector.tar.gz");
		expect(pin.asset_sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const lock of ["web/bun.lock", "bun.lock"]) {
			expect({ lock, ...lockedPackage(await read(lock), pin.package) }).toEqual({ lock, version: pin.version, integrity: pin.integrity });
		}
	});

	test("is the only place the asset checksum lives, and both consumers read it", async () => {
		for (const consumer of CONSUMERS) {
			const text = await read(consumer);
			expect({ consumer, checksums: text.match(/\b[0-9a-f]{64}\b/g) ?? [] }).toEqual({ consumer, checksums: [] });
		}
		expect(await read(CONSUMERS[0])).toContain(PIN);
	});
});
