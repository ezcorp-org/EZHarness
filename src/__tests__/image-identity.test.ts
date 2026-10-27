/**
 * The proof scripts read every image ID through one place: `identify` / `config-digest` in
 * scripts/production-image-artifact.ts, called from shell by scripts/lib/image-identity.sh. Docker's containerd image
 * store reports a manifest list's digest as `.Id` where Podman and Docker's classic store report the config digest, so
 * these tests run each case in both forms against real archive shapes and fake engines.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cli, type Fixture, fixture, hex, IMAGE, IMAGE_ID, LIST_ID, ociIndexArchive, REVISION, writeTar } from "./helpers/image-archive-fixture.ts";

let value: Fixture;
beforeEach(async () => {
	value = await fixture();
});
afterEach(async () => {
	await rm(value.root, { recursive: true, force: true });
});

const ROOT = join(import.meta.dir, "..", "..");
const FOREIGN_ID = `sha256:${"b".repeat(64)}`;

/** Packs the candidate in the containerd form: Docker reports the list digest, Podman the config digest. */
async function packContainerdForm(value: Fixture): Promise<void> {
	await writeTar(value.env.SAVE_TAR!, ociIndexArchive());
	value.env.DOCKER_IMAGE_ID = LIST_ID;
	value.env.PODMAN_IMAGE_ID = hex(IMAGE_ID);
	await cli(value, ["pack", IMAGE, REVISION, value.outdir]);
}

test("identify gives the packed candidate's config digest for each engine, in either store form", async () => {
	await cli(value, ["pack", IMAGE, REVISION, value.outdir]);
	expect(await cli(value, ["identify", value.outdir, "docker", IMAGE])).toBe(IMAGE_ID);
	await rm(value.outdir, { recursive: true, force: true });
	await packContainerdForm(value);
	expect(await cli(value, ["identify", value.outdir, "docker", IMAGE])).toBe(IMAGE_ID);
	expect(await cli(value, ["identify", value.outdir, "podman", IMAGE])).toBe(IMAGE_ID);
});

test("identify refuses an engine ID that is not the packed candidate", async () => {
	await packContainerdForm(value);
	value.env.DOCKER_IMAGE_ID = FOREIGN_ID;
	await expect(cli(value, ["identify", value.outdir, "docker", IMAGE])).rejects.toThrow(`docker image ID ${FOREIGN_ID} is not the packed candidate ${IMAGE_ID}`);
});

test("identify keeps the engine's own ID for another image, and when no artifact exists", async () => {
	await packContainerdForm(value);
	expect(await cli(value, ["identify", value.outdir, "docker", "localhost/other:1"])).toBe(LIST_ID);
	expect(await cli(value, ["identify", join(value.root, "absent"), "docker", IMAGE])).toBe(LIST_ID);
	await expect(cli(value, ["identify", value.outdir, "runc", IMAGE])).rejects.toThrow("engine must be docker or podman");
});

test("config-digest reads an unpacked image's config digest from the engine's own save", async () => {
	await writeTar(value.env.SAVE_TAR!, ociIndexArchive());
	value.env.DOCKER_IMAGE_ID = LIST_ID;
	expect(await cli(value, ["config-digest", "docker", "localhost/previous:1"])).toBe(IMAGE_ID);
	expect(await readFile(value.log, "utf8")).toContain("docker image save -o");
	value.env.DOCKER_IMAGE_ID = FOREIGN_ID;
	await expect(cli(value, ["config-digest", "docker", "localhost/previous:1"])).rejects.toThrow("is not the image it saved");
});

/** Runs the shipping suite up to its proof selection: an unknown shard stops it right after the identity checks. */
async function suite(value: Fixture, script = "scripts/verify-shipping-production-suite.sh") {
	const receipts = await mkdtemp(join(tmpdir(), "shipping-suite-"));
	const child = Bun.spawn(["bash", script], {
		cwd: ROOT,
		env: {
			...value.env,
			EZ_SHIPPING_CANDIDATE_IMAGE: IMAGE,
			EZ_SHIPPING_RECEIPT_ROOT: receipts,
			VERIFY_UPGRADE_CANDIDATE_SOURCE: REVISION,
			EZ_SHIPPING_SHARD: "no-such-shard",
			EZ_SHIPPING_EXPECTED_IMAGE_ID: IMAGE_ID,
			EZ_SHIPPING_CANDIDATE_ARTIFACT: value.outdir,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	const provenance = await Bun.file(join(receipts, "provenance.txt")).text().catch(() => "");
	await rm(receipts, { recursive: true, force: true });
	return { exit, stderr, provenance };
}

test("the shipping suite's engine check holds for a candidate in the containerd form", async () => {
	await packContainerdForm(value);
	const result = await suite(value);
	// It gets past both identity checks and writes provenance, then stops at the unknown shard.
	expect(result.stderr).not.toContain("Candidate image ID differs");
	expect(result.stderr).toContain("unknown production proof shard: no-such-shard");
	expect(result.provenance).toContain(`expected_image_id=${IMAGE_ID}\ndocker_image_id=${IMAGE_ID}\npodman_image_id=${IMAGE_ID}\n`);
	expect(result.exit).not.toBe(0);
});

test("image_identity, the shell entry the proof scripts source, gives the same IDs as identify", async () => {
	await packContainerdForm(value);
	const ids = Bun.spawnSync(["bash", "-c", 'source scripts/lib/image-identity.sh && image_identity docker "$1" && image_identity podman "$1" && image_identity docker localhost/other:1', "--", IMAGE], {
		cwd: ROOT,
		env: { ...value.env, EZ_SHIPPING_CANDIDATE_ARTIFACT: value.outdir },
	});
	expect(ids.exitCode).toBe(0);
	expect(ids.stdout.toString().trim().split("\n")).toEqual([IMAGE_ID, IMAGE_ID, LIST_ID]);
});

test("every proof script reads image IDs through image_identity or config-digest, never a raw .Id comparison", async () => {
	const scripts = ["verify-shipping-production-suite.sh", "verify-production-image-lifecycle.sh", "verify-legacy-adoption.sh", "verify-docker-upgrade.sh"];
	for (const script of scripts) {
		const text = await Bun.file(join(ROOT, "scripts", script)).text();
		const rawCandidateReads = text.split("\n").filter((line) => /\{\{\.Id\}\}/.test(line) && !/legacy_base_image|legacy_image/.test(line));
		expect({ script, rawCandidateReads }).toEqual({ script, rawCandidateReads: [] });
	}
});
