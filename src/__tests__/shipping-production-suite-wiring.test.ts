import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../..");
const suite = resolve(root, "scripts/verify-shipping-production-suite.sh");
const shell = Bun.which("bash") ?? (() => { throw new Error("bash is required for the shipping suite test"); })();

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

async function runSuite(directory: string, receipt: string, podmanId: string, shard = "", expectedImageId: string | null = `sha256:${"b".repeat(64)}`): Promise<{ code: number; output: string }> {
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
      EZ_SHIPPING_SHARD: shard,
      VERIFY_UPGRADE_CANDIDATE_SOURCE: "a".repeat(40),
      EZ_SHIPPING_EXPECTED_IMAGE_ID: expectedImageId ?? "",
      FAKE_DOCKER_IMAGE_ID: `sha256:${"b".repeat(64)}`,
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

test("shipping suite attests the independent image ID, retains later proof receipts, and returns failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipping-suite-"));
  try {
    const fake = join(directory, "bin");
    await mkdir(fake);
    await createFakeEngines(fake);
    const receipt = join(directory, "receipts");
    const result = await runSuite(directory, receipt, "b".repeat(64), "", null);
    expect(result.code).toBe(1);
    const summary = await readFile(join(receipt, "summary.tsv"), "utf8");
    expect(summary).toContain("runtime\t7\t");
    for (const proof of ["embeddings", "delivery", "revocation", "runtime-resources", "historical-upgrade", "legacy-adoption"]) {
      expect(summary).toContain(`${proof}\t0\t`);
      expect(await Bun.file(join(receipt, proof, "controller.log")).exists()).toBe(true);
    }
    expect(await Bun.file(join(receipt, "file-organizer", "controller.log")).exists()).toBe(true);
    const provenance = await readFile(join(receipt, "provenance.txt"), "utf8");
    expect(provenance).toContain(`docker_image_id=sha256:${"b".repeat(64)}`);
    expect(provenance).toContain(`expected_image_id=sha256:${"b".repeat(64)}`);
    expect(provenance).toContain(`source_revision=${"a".repeat(40)}`);
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
    const mismatch = await runSuite(directory, join(directory, "mismatch"), "c".repeat(64));
    expect(mismatch.code).toBe(1);
    expect(mismatch.output).toContain("Candidate image ID differs");

    const stale = join(directory, "stale");
    await mkdir(stale);
    await writeFile(join(stale, "old-receipt"), "stale");
    const refusal = await runSuite(directory, stale, "b".repeat(64));
    expect(refusal.code).toBe(2);
    expect(refusal.output).toContain("Receipt root must be empty");

    const unknown = await runSuite(directory, join(directory, "unknown"), "b".repeat(64), "not-a-shard");
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain("unknown production proof shard");

    const namedMissingExpected = await runSuite(directory, join(directory, "named-missing-expected"), "b".repeat(64), "content", null);
    expect(namedMissingExpected.code).toBe(2);
    expect(namedMissingExpected.output).toContain("Set EZ_SHIPPING_EXPECTED_IMAGE_ID for a CI shard");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shipping suite delegates selection to the shared plan and keeps the namespace proof isolated", async () => {
  const source = await Bun.file(suite).text();
  expect(source).toContain(`bun scripts/production-proof-plan.ts select "\${EZ_SHIPPING_SHARD:-}"`);
  expect(source).toContain('"EZCORP_STAGE2_PROOF=1"');
  expect(source).toContain('"EZCORP_STAGE2_PROOF_IMAGE=$candidate"');
  expect(source).toContain("journalctl -k --no-pager -n 1 -o json | jq -e");
  expect(source).toContain("mcp-netns-raw-socket-blocked.test.ts");
  expect(source).toContain("mcp-stage2-ipv6-disabled.test.ts");
  expect(source).toContain("mcp-stage2-conntrack-soak.test.ts");
});
