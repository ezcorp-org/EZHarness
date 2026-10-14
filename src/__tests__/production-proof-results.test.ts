import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRODUCTION_PROOF_SHARDS } from "../../scripts/production-proof-plan.ts";
import { RUNNER_ISOLATION_PROOF_FILE, RUNNER_ISOLATION_PROOF_TESTS, verifyShippingProductionResults } from "../../scripts/verify-shipping-production-results.ts";

const REVISION = "a".repeat(40);
const IMAGE = `sha256:${"b".repeat(64)}`;
const HEADER = "proof\texit\tstarted_at\tfinished_at\tduration_ms\treceipt";
/** The namespace receipt as the shipping suite writes it: Bun's own report of the runner isolation proof. */
function namespaceController(lines: readonly string[] = RUNNER_ISOLATION_PROOF_TESTS.map(name => `(pass) ${name} [10.00ms]`), summary = `\n ${RUNNER_ISOLATION_PROOF_TESTS.length} pass\n 0 fail\n 52 expect() calls\nRan ${RUNNER_ISOLATION_PROOF_TESTS.length} tests across 1 file. [63.92s]\n`): string {
  return `bun test v1.4.2 (744846f84)\n\n::group::${RUNNER_ISOLATION_PROOF_FILE}:\n\x1b[32m${lines.join("\n")}\x1b[0m\n\n::endgroup::\n${summary}`;
}
const NAMESPACE_CONTROLLER = namespaceController();
const LIVE_ARM = RUNNER_ISOLATION_PROOF_TESTS.find(name => name.startsWith("runner worker isolation (live) > "))!;
const OLD_NAMESPACE_CONTROLLER = `(pass) the production namespace blocks direct TCP; removing only nft makes the deny assertion fail
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

async function writeNamespace(root: string, text: string): Promise<void> {
  await writeFile(join(root, "production-proof-namespace", "namespace", "controller.log"), text);
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
    { name: "partial namespace receipt", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace(`(pass) ${LIVE_ARM} [10.00ms]\n`, "")); }, message: "missing test" },
    { name: "skipped live arm", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace(`(pass) ${LIVE_ARM}`, `(skip) ${LIVE_ARM}`).replace(` ${RUNNER_ISOLATION_PROOF_TESTS.length} pass`, ` ${RUNNER_ISOLATION_PROOF_TESTS.length - 1} pass\n 1 skip`)); }, message: "did not pass" },
    { name: "every live arm skipped", change: async ({ root }) => { await writeNamespace(root, namespaceController(RUNNER_ISOLATION_PROOF_TESTS.map(name => `(${name.includes("(live)") ? "skip" : "pass"}) ${name}`))); }, message: "did not pass" },
    { name: "failed arm", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace(`(pass) ${LIVE_ARM}`, `(fail) ${LIVE_ARM}`).replace(" 0 fail", " 1 fail")); }, message: "did not pass" },
    { name: "summary count mismatch", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace(` ${RUNNER_ISOLATION_PROOF_TESTS.length} pass`, ` ${RUNNER_ISOLATION_PROOF_TESTS.length + 1} pass`)); }, message: "summary" },
    { name: "unknown extra test", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace("::endgroup::", "(pass) an extra test [1.00ms]\n::endgroup::")); }, message: "unexpected test" },
    { name: "another test file", change: async ({ root }) => { await writeNamespace(root, NAMESPACE_CONTROLLER.replace(`::group::${RUNNER_ISOLATION_PROOF_FILE}:`, "::group::src/__tests__/other.proof.test.ts:")); }, message: RUNNER_ISOLATION_PROOF_FILE },
    { name: "old Stage 2 receipt", change: async ({ root }) => { await writeNamespace(root, OLD_NAMESPACE_CONTROLLER); }, message: "namespace controller" },
    { name: "Stage 2 environment in the receipt", change: async ({ root }) => { await writeNamespace(root, `EZCORP_STAGE2_PROOF=1\n${NAMESPACE_CONTROLLER}`); }, message: "Stage 2" },
    { name: "old Stage 2 file in the receipt", change: async ({ root }) => { await writeNamespace(root, `${NAMESPACE_CONTROLLER}src/__tests__/mcp-netns-raw-socket-blocked.test.ts:\n`); }, message: "Stage 2" },
    { name: "namespace receipt from another revision", change: async ({ root }) => { await writeFile(join(root, "production-proof-namespace", "provenance.txt"), `source_revision=${"c".repeat(40)}\nexpected_image_id=${IMAGE}\ndocker_image_id=${IMAGE}\npodman_image_id=${IMAGE}\nshard=namespace\n`); }, message: "source_revision" },
    { name: "namespace receipt from another image", change: async ({ root }) => { await writeFile(join(root, "production-proof-namespace", "provenance.txt"), `source_revision=${REVISION}\nexpected_image_id=${IMAGE}\ndocker_image_id=sha256:${"c".repeat(64)}\npodman_image_id=${IMAGE}\nshard=namespace\n`); }, message: "Docker image ID" },
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

test("the verifier's namespace test list is exactly the tests the runner isolation proof declares", async () => {
  // Without EZCORP_RUNNER_ISOLATION_PROOF the live arms are skipped, and the
  // JUnit report still lists every declared test, live or not.
  const base = await mkdtemp(join(tmpdir(), "namespace-proof-names-"));
  try {
    const report = join(base, "junit.xml");
    const run = Bun.spawnSync([process.execPath, "test", `./${RUNNER_ISOLATION_PROOF_FILE}`, "--reporter=junit", `--reporter-outfile=${report}`], { env: { ...process.env, EZCORP_RUNNER_ISOLATION_PROOF: "" }, stdout: "ignore", stderr: "ignore" });
    expect(run.exitCode).toBe(0);
    const declared = [...(await readFile(report, "utf8")).matchAll(/<testcase name="([^"]*)" classname="([^"]*)"/g)]
      .filter(([, name]) => name !== "(unnamed)")
      .map(([, name, describe]) => `${describe} > ${name}`.replaceAll("&quot;", "\"").replaceAll("&amp;", "&"));
    expect(declared.toSorted()).toEqual([...RUNNER_ISOLATION_PROOF_TESTS].toSorted());
  } finally { await rm(base, { recursive: true, force: true }); }
});
