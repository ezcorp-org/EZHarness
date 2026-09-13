import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRODUCTION_PROOF_SHARDS } from "../../scripts/production-proof-plan.ts";
import { verifyShippingProductionResults } from "../../scripts/verify-shipping-production-results.ts";

const REVISION = "a".repeat(40);
const IMAGE = `sha256:${"b".repeat(64)}`;
const HEADER = "proof\texit\tstarted_at\tfinished_at\tduration_ms\treceipt";
const NAMESPACE_CONTROLLER = `\x1b[32m(pass)\x1b[0m the production namespace blocks direct TCP; removing only nft makes the deny assertion fail
(pass) the launcher removes seeded IPv6 while IPv4 proxy traffic works; omitting only the disable writes fails
(pass) four workers complete 400 real proxy requests over five minutes and leave no owned containers
(pass) a killed worker fails the same controller despite low connection counts
4 pass
0 fail
`;

function launchers(proof: string): string[] {
  if (proof === "historical-upgrade") return ["upgrade/seed-previous", "upgrade/assert-candidate", "upgrade/assert-restore"];
  if (proof === "legacy-adoption") return ["legacy/seed", "legacy/adopt"];
  if (proof === "namespace") return [];
  return ["runtime"];
}

async function receipt(root: string, proof: string): Promise<void> {
  const proofRoot = join(root, proof);
  await mkdir(proofRoot, { recursive: true });
  await writeFile(join(proofRoot, "controller.log"), proof === "namespace" ? NAMESPACE_CONTROLLER : `${proof} controller\n`);
  for (const launcher of launchers(proof)) {
    const launcherRoot = join(proofRoot, launcher);
    await mkdir(launcherRoot, { recursive: true });
    await writeFile(join(launcherRoot, "command.log"), "command_exit=0\napp_log_exit=0\nowned_cleanup_exit=0\nverifier_cleanup_exit=0\n");
    const archived = (proof === "historical-upgrade" && launcher === "upgrade/seed-previous") || (proof === "legacy-adoption" && launcher === "legacy/seed");
    const archivedRevision = proof === "historical-upgrade" && launcher === "upgrade/seed-previous" ? "<no value>" : "c".repeat(40);
    await writeFile(join(launcherRoot, "provenance.txt"), `launcher_source=${REVISION}\nimage_id=${archived ? `sha256:${"c".repeat(64)}` : IMAGE} revision=${archived ? archivedRevision : REVISION}\n`);
  }
}

async function fixture(): Promise<{ base: string; root: string; output: string }> {
  const base = await mkdtemp(join(tmpdir(), "production-proof-results-"));
  const root = join(base, "inputs");
  await mkdir(root);
  for (const { shard, proofs } of PRODUCTION_PROOF_SHARDS) {
    const artifact = join(root, `production-proof-${shard}`);
    await mkdir(artifact);
    await writeFile(join(artifact, "provenance.txt"), `source_revision=${REVISION}\nexpected_image_id=${IMAGE}\ndocker_image_id=${IMAGE}\npodman_image_id=${IMAGE}\nshard=${shard}\n`);
    const rows: string[] = [];
    for (const [index, { name }] of proofs.entries()) {
      await receipt(artifact, name);
      const started = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2));
      const finished = new Date(started.getTime() + 1000);
      rows.push(`${name}\t0\t${started.toISOString()}\t${finished.toISOString()}\t1000\t${name}`);
    }
    await writeFile(join(artifact, "summary.tsv"), `${HEADER}\n${rows.join("\n")}\n`);
  }
  return { base, root, output: join(base, "verified") };
}

async function withFixture(assertion: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const value = await fixture();
  try { await assertion(value); } finally { await rm(value.base, { recursive: true, force: true }); }
}

test("aggregate verifies all five artifacts, eleven launcher cleanups, and copies proof paths", async () => {
  await withFixture(async ({ root, output }) => {
    const verified = await verifyShippingProductionResults(root, REVISION, IMAGE, output);
    expect(verified).toHaveLength(5);
    expect(await Bun.file(join(output, "runtime", "runtime", "command.log")).exists()).toBe(true);
    expect(await Bun.file(join(output, "historical-upgrade", "upgrade", "assert-restore", "command.log")).exists()).toBe(true);
    expect(await Bun.file(join(output, "legacy-adoption", "legacy", "adopt", "command.log")).exists()).toBe(true);
    expect(await readFile(join(output, "summary.tsv"), "utf8")).toContain("namespace\tnamespace\t0");
    expect(JSON.parse(await readFile(join(output, "timing.json"), "utf8"))).toMatchObject({ totalProofDurationMs: 9000 });
  });
});

test("aggregate rejects missing, stale, wrong-image, malformed, failed, cancelled, duplicate, and incomplete evidence", async () => {
  const cases: Array<{ name: string; change(value: Awaited<ReturnType<typeof fixture>>): Promise<void>; message: string }> = [
    { name: "missing artifact", change: async ({ root }) => { await rm(join(root, "production-proof-namespace"), { recursive: true }); }, message: "exactly five artifacts" },
    { name: "stale source", change: async ({ root }) => { await writeFile(join(root, "production-proof-content", "provenance.txt"), `source_revision=${"c".repeat(40)}\nexpected_image_id=${IMAGE}\ndocker_image_id=${IMAGE}\npodman_image_id=${IMAGE}\nshard=content\n`); }, message: "source_revision" },
    { name: "wrong image", change: async ({ root }) => { await writeFile(join(root, "production-proof-content", "provenance.txt"), `source_revision=${REVISION}\nexpected_image_id=sha256:${"c".repeat(64)}\ndocker_image_id=sha256:${"c".repeat(64)}\npodman_image_id=sha256:${"c".repeat(64)}\nshard=content\n`); }, message: "expected image ID" },
    { name: "failed proof", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); await writeFile(path, (await readFile(path, "utf8")).replace("runtime\t0", "runtime\t1")); }, message: "did not succeed" },
    { name: "cancelled proof", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); await writeFile(path, (await readFile(path, "utf8")).replace("runtime\t0", "runtime\t130")); }, message: "did not succeed" },
    { name: "malformed timestamp", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); await writeFile(path, (await readFile(path, "utf8")).replace("2026-01-01T00:00:00.000Z", "not-a-time")); }, message: "invalid timestamps" },
    { name: "overlapping proofs", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); const summary = await readFile(path, "utf8"); await writeFile(path, summary.replace("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:00.500Z").replace("2026-01-01T00:00:03.000Z", "2026-01-01T00:00:01.500Z")); }, message: "overlap" },
    { name: "duplicate proof", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); await writeFile(path, `${await readFile(path, "utf8")}runtime\t0\t2026-01-01T00:00:00.000Z\t2026-01-01T00:00:01.000Z\t1000\truntime\n`); }, message: "duplicate" },
    { name: "incomplete proof set", change: async ({ root }) => { await writeFile(join(root, "production-proof-recovery", "summary.tsv"), `${HEADER}\nruntime\t0\t2026-01-01T00:00:00.000Z\t2026-01-01T00:00:01.000Z\t1000\truntime\n`); }, message: "missing proof" },
    { name: "unsafe receipt traversal", change: async ({ root }) => { const path = join(root, "production-proof-recovery", "summary.tsv"); await writeFile(path, (await readFile(path, "utf8")).replace("\truntime\n", "\t../runtime\n")); }, message: "unsafe receipt path" },
    { name: "symlinked receipt", change: async ({ root }) => { const artifact = join(root, "production-proof-namespace"); await rm(join(artifact, "namespace", "controller.log")); await symlink("../../production-proof-content/file-organizer/controller.log", join(artifact, "namespace", "controller.log")); }, message: "unsafe file type" },
    { name: "directory controller log", change: async ({ root }) => { const path = join(root, "production-proof-namespace", "namespace", "controller.log"); await rm(path); await mkdir(path); }, message: "not a regular file" },
    { name: "stale nested candidate provenance", change: async ({ root }) => { await writeFile(join(root, "production-proof-recovery", "runtime", "runtime", "provenance.txt"), `launcher_source=${REVISION}\nimage_id=${IMAGE} revision=${"c".repeat(40)}\n`); }, message: "candidate launcher provenance" },
    { name: "empty namespace receipt", change: async ({ root }) => { await writeFile(join(root, "production-proof-namespace", "namespace", "controller.log"), ""); }, message: "namespace controller" },
    { name: "partial namespace receipt", change: async ({ root }) => { await writeFile(join(root, "production-proof-namespace", "namespace", "controller.log"), NAMESPACE_CONTROLLER.replace("a killed worker fails the same controller despite low connection counts\n", "")); }, message: "missing real test" },
    { name: "skipped namespace receipt", change: async ({ root }) => { await writeFile(join(root, "production-proof-namespace", "namespace", "controller.log"), `${NAMESPACE_CONTROLLER}1 skip\n`); }, message: "skipped tests" },
  ];
  for (const scenario of cases) await withFixture(async (value) => {
    await scenario.change(value);
    await expect(verifyShippingProductionResults(value.root, REVISION, IMAGE, value.output)).rejects.toThrow(scenario.message);
  });
});

test("aggregate refuses overlapping or nonempty output roots without deleting inputs", async () => {
  await withFixture(async ({ root, output }) => {
    await expect(verifyShippingProductionResults(root, REVISION, IMAGE, join(root, ".."))).rejects.toThrow("must not overlap");
    const nested = join(root, "production-proof-content", "file-organizer", "nested-output");
    await expect(verifyShippingProductionResults(root, REVISION, IMAGE, nested)).rejects.toThrow("must not overlap");
    expect(await Bun.file(join(root, "production-proof-content", "file-organizer", "controller.log")).exists()).toBe(true);
    await mkdir(output);
    await writeFile(join(output, "keep"), "must remain");
    await expect(verifyShippingProductionResults(root, REVISION, IMAGE, output)).rejects.toThrow("absent or an empty");
    expect(await Bun.file(join(output, "keep")).text()).toBe("must remain");
  });
});

test("aggregate rejects each failed cleanup stage and missing launcher receipts", async () => {
  for (const field of ["command_exit", "app_log_exit", "owned_cleanup_exit", "verifier_cleanup_exit"]) {
    await withFixture(async ({ root, output }) => {
      const path = join(root, "production-proof-recovery", "historical-upgrade", "upgrade", "seed-previous", "command.log");
      await writeFile(path, (await readFile(path, "utf8")).replace(`${field}=0`, `${field}=1`));
      await expect(verifyShippingProductionResults(root, REVISION, IMAGE, output)).rejects.toThrow(`${field} does not match`);
    });
  }
  await withFixture(async ({ root, output }) => {
    await rm(join(root, "production-proof-resources", "runtime-resources", "runtime", "command.log"));
    await expect(verifyShippingProductionResults(root, REVISION, IMAGE, output)).rejects.toThrow("command.log is missing");
  });
});
