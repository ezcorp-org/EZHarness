/**
 * The legacy-adoption proof installs a pgvector asset into the legacy main image
 * (`scripts/legacy-adoption-vector-asset.pin`): the legacy release's own, from its root install. This checks that the
 * pin names what that release locked (and that the candidate's two locks agree with each other), that the pin is the
 * ONLY place the asset's checksum lives, and that the install step the derived image runs
 * (`scripts/lib/legacy-vector-asset.sh`) refuses any other bytes or version.
 *
 * Before, the derived image copied the candidate's asset, and the pin had to follow every candidate pgvector bump. A
 * rebuilt pgvector (0.0.11, for PGlite 0.5.10) cannot load under the legacy PGlite 0.5.7, which made the legacy app
 * exit at boot (#367).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PIN = "scripts/legacy-adoption-vector-asset.pin";
const INSTALL = "scripts/lib/legacy-vector-asset.sh";
const CONSUMERS = ["scripts/verify-legacy-adoption.sh", "scripts/Dockerfile.legacy-adoption-derived"];
const LEGACY_LOCK = "src/__tests__/fixtures/legacy-main-537f074e-bun.lock.txt";

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
	test("names the pglite-pgvector the legacy source locked, by version and tarball integrity", async () => {
		const pin = parsePin(await read(PIN));
		const fixture = await read(LEGACY_LOCK);
		expect(pin.package).toBe("@electric-sql/pglite-pgvector");
		expect(pin.asset).toBe("dist/vector.tar.gz");
		expect(pin.asset_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(fixture).toContain(`bun.lock at legacy main ${pin.source} `);
		expect(lockedPackage(fixture, pin.package)).toEqual({ version: pin.version, integrity: pin.integrity });
	});

	test("the candidate side: bun.lock and web/bun.lock resolve the same pglite and pglite-pgvector, by name", async () => {
		const [root, web] = await Promise.all([read("bun.lock"), read("web/bun.lock")]);
		for (const name of ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"]) {
			const locked = lockedPackage(root, name);
			expect(locked).not.toBeNull();
			expect({ name, ...lockedPackage(web, name) }).toEqual({ name, ...locked });
		}
	});

	test("names the legacy source the verifier runs by default", async () => {
		const pin = parsePin(await read(PIN));
		expect(await read(CONSUMERS[0])).toContain(`VERIFY_LEGACY_ADOPTION_LEGACY_SOURCE:-${pin.source}}`);
	});

	test("is the only place the asset checksum lives, and both consumers read it", async () => {
		for (const consumer of CONSUMERS) {
			const text = await read(consumer);
			expect({ consumer, checksums: text.match(/\b[0-9a-f]{64}\b/g) ?? [] }).toEqual({ consumer, checksums: [] });
		}
		expect(await read(CONSUMERS[0])).toContain(PIN);
		expect(await read(CONSUMERS[1])).toContain(INSTALL);
	});
});

describe("the derived image's install step", () => {
	let dir = "";
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** A fake pglite-pgvector package dir with the given manifest fields and asset bytes; returns its path and sha. */
	async function fakePackage(version: string, bytes: string, extra: Record<string, unknown> = {}): Promise<{ pkg: string; sha256: string }> {
		dir = await mkdtemp(join(tmpdir(), "legacy-vector-asset-"));
		const pkg = join(dir, "pglite-pgvector");
		await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "@electric-sql/pglite-pgvector", ...extra, version }, null, 2));
		await Bun.write(join(pkg, "dist", "vector.tar.gz"), bytes);
		return { pkg, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
	}

	function install(pkg: string, sha256: string, version: string) {
		const target = join(dir, "vector.tar.gz");
		const result = Bun.spawnSync(["sh", join(ROOT, INSTALL), pkg, target, sha256, version], { stderr: "pipe" });
		return { exitCode: result.exitCode, stderr: result.stderr.toString(), installed: Bun.file(target) };
	}

	test("installs the pinned bytes", async () => {
		const { pkg, sha256 } = await fakePackage("0.0.8", "legacy asset");
		const result = install(pkg, sha256, "0.0.8");
		expect(result.exitCode).toBe(0);
		expect(await result.installed.text()).toBe("legacy asset");
	});

	test("refuses a wrong sha256 and installs nothing", async () => {
		const { pkg } = await fakePackage("0.0.8", "other asset");
		const result = install(pkg, "0".repeat(64), "0.0.8");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("pinned 0000");
		expect(await result.installed.exists()).toBe(false);
	});

	test("reads the version from the manifest's own field, not from text elsewhere in it", async () => {
		const { pkg, sha256 } = await fakePackage("0.0.11", "candidate asset", { peerDependencies: { x: { "version": "0.0.8" } }, description: '"version": "0.0.8"' });
		const result = install(pkg, sha256, "0.0.8");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("is pglite-pgvector 0.0.11, pinned 0.0.8");
	});

	test("refuses another package version, and a missing pin value", async () => {
		const { pkg, sha256 } = await fakePackage("0.0.11", "candidate asset");
		expect(install(pkg, sha256, "0.0.8").exitCode).toBe(1);
		expect(install(pkg, "", "0.0.11").exitCode).toBe(2);
	});
});
