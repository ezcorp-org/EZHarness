import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../..");
const suite = resolve(root, "scripts/verify-shipping-production-suite.sh");
const shell = Bun.which("bash");
if (!shell) throw new Error("bash is required for the shipping suite test");

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!${shell}\nset -euo pipefail\n${body}`, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function createFakeEngines(directory: string): Promise<void> {
  await executable(join(directory, "docker"), `
if [[ "$1" == image && "$2" == inspect ]]; then printf '%s\\n' "\${FAKE_DOCKER_IMAGE_ID:?}"; exit 0; fi
exit 99
`);
  await executable(join(directory, "podman"), `
if [[ "$1" == image && "$2" == inspect ]]; then printf '%s\\n' "\${FAKE_PODMAN_IMAGE_ID:?}"; exit 0; fi
exit 99
`);
  await executable(join(directory, "timeout"), `
while [[ "$1" == -* ]]; do shift; done
shift
exec "$@"
`);
  await executable(join(directory, "bash"), `
case "$1" in
  *verify-shipping-runtime.sh) status=7 ;;
  *) status=0 ;;
esac
if [[ -n "\${EZ_RUNTIME_RECEIPT_DIR:-}" ]]; then mkdir -p "$EZ_RUNTIME_RECEIPT_DIR"; fi
if [[ -n "\${EZ_PRODUCTION_RECEIPT_DIR:-}" ]]; then mkdir -p "$EZ_PRODUCTION_RECEIPT_DIR"; fi
printf 'leaf=%s\\n' "$1"
exit "$status"
`);
}

async function runSuite(directory: string, receipt: string, podmanId: string): Promise<{ code: number; output: string }> {
  const fake = join(directory, "bin");
  const child = Bun.spawn({
    cmd: [shell, suite],
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
      EZ_SHIPPING_CANDIDATE_IMAGE: "ezcorp:test-candidate",
      EZ_SHIPPING_RECEIPT_ROOT: receipt,
      EZ_SHIPPING_APP_UID: "1001",
      EZ_SHIPPING_APP_GID: "1001",
      EZ_SHIPPING_RUNNER_APP_UID: "1001",
      VERIFY_UPGRADE_CANDIDATE_SOURCE: "a".repeat(40),
      FAKE_DOCKER_IMAGE_ID: "sha256:abc123",
      FAKE_PODMAN_IMAGE_ID: podmanId,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

test("shipping suite normalizes engine image IDs, retains later proof receipts, and returns failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipping-suite-"));
  try {
    const fake = join(directory, "bin");
    await mkdir(fake);
    await createFakeEngines(fake);
    const receipt = join(directory, "receipts");
    const result = await runSuite(directory, receipt, "abc123");
    expect(result.code).toBe(1);
    const summary = await readFile(join(receipt, "summary.tsv"), "utf8");
    expect(summary).toContain("runtime\t7\t");
    for (const proof of ["delivery", "revocation", "runtime-resources", "historical-upgrade"]) {
      expect(summary).toContain(`${proof}\t0\t`);
      expect(await Bun.file(join(receipt, proof, "controller.log")).exists()).toBe(true);
    }
    expect(await Bun.file(join(receipt, "file-organizer", "controller.log")).exists()).toBe(true);
    expect(await readFile(join(receipt, "provenance.txt"), "utf8")).toContain("docker_image_id=sha256:abc123");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shipping suite rejects mismatched engine candidates and nonempty receipt roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipping-suite-"));
  try {
    const fake = join(directory, "bin");
    await mkdir(fake);
    await createFakeEngines(fake);
    const mismatch = await runSuite(directory, join(directory, "mismatch"), "different");
    expect(mismatch.code).toBe(1);
    expect(mismatch.output).toContain("Candidate image ID differs");

    const stale = join(directory, "stale");
    await mkdir(stale);
    await writeFile(join(stale, "old-receipt"), "stale");
    const refusal = await runSuite(directory, stale, "abc123");
    expect(refusal.code).toBe(2);
    expect(refusal.output).toContain("Receipt root must be empty");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
