#!/usr/bin/env bun
/** Verify isolated production-proof artifacts before publishing one receipt. */
import { copyFile, lstat, mkdir, readdir, readFile, chmod } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PRODUCTION_PROOF_SHARDS, proofBoundTests } from "./production-proof-plan.ts";

type SummaryRow = { proof: string; exit: number; startedAt: string; finishedAt: string; durationMs: number; receipt: string };
type VerifiedShard = { shard: string; rows: SummaryRow[]; artifact: string };

const SUMMARY_HEADER = "proof\texit\tstarted_at\tfinished_at\tduration_ms\treceipt";
const CLEANUP_RECEIPTS: Readonly<Record<string, readonly string[]>> = {
  "file-organizer": ["runtime"], embeddings: ["runtime"], runtime: ["runtime"], delivery: ["runtime"],
  revocation: ["runtime"], "runtime-resources": ["runtime"],
  "historical-upgrade": ["upgrade/seed-previous", "upgrade/assert-candidate", "upgrade/assert-restore"],
  "legacy-adoption": ["legacy/seed", "legacy/adopt"], namespace: [], "preview-isolation": [],
};
/** The `namespace` proof: the extension runner's worker isolation, run live on the candidate image. */
export const RUNNER_ISOLATION_PROOF_FILE = "src/__tests__/runner-worker-isolation.proof.test.ts";
const LIVE = "runner worker isolation (live) > ";
const OFFLINE = "runner worker isolation (argv and fail-closed startup) > ";
/** Every test the proof declares. Each must pass: a skipped live arm is not evidence. */
export const RUNNER_ISOLATION_PROOF_TESTS: readonly string[] = Object.freeze([
  `${LIVE}a production worker is isolated on every control`,
  `${LIVE}a worker without the shell grant cannot start a process but can start a thread; an allow worker can`,
  `${LIVE}without the guard a deny worker starts a process`,
  `${LIVE}the shim is non-dumpable after it spawns, so a non-shell worker cannot open its memory file`,
  `${LIVE}FAULT ARM: with a dumpable shim the same read-only open succeeds`,
  `${LIVE}without --network=none the worker has a network, and startup refuses it`,
  `${LIVE}with an unconfined seccomp profile add_key no longer fails with ENOSYS, and startup refuses it`,
  `${LIVE}without --read-only the image root is writable, and startup refuses it`,
  `${OFFLINE}every worker launch carries the isolation flags`,
  `${OFFLINE}the shipped seccomp profile is deny-by-default and does not allow add_key`,
  `${OFFLINE}startup refuses a host that is not rootless`,
  `${OFFLINE}startup refuses a host that is without seccomp`,
  `${OFFLINE}startup refuses a host that is on cgroup v1`,
  `${OFFLINE}startup refuses a host that is without the pids controller`,
  `${OFFLINE}startup refuses a seccomp profile that is not deny-by-default`,
  `${OFFLINE}startup refuses when the worker probe does not match the secure profile`,
]);
const KEYSTONE = "uid keystone — LIVE (production image) > ";
const DYNAMIC = "dynamic preview — LIVE e2e (production image) > ";
/** The `preview-isolation` proof: the uid-based preview isolation tests, run inside the candidate image. */
export const PREVIEW_ISOLATION_PROOF_TESTS: readonly string[] = Object.freeze([
  `${KEYSTONE}setuid helper present + 4755 root-owned in the image`,
  `${KEYSTONE}preview uid CANNOT read .ezcorp/data (chmod 0700) — keystone`,
  `${KEYSTONE}helper refuses an out-of-range uid even invoked directly`,
  `${KEYSTONE}ProcPortSource attributes a live listener by its preview uid`,
  `${DYNAMIC}spawn as preview uid → ProcPortSource detects → loopback fetch 200`,
  `${DYNAMIC}reapPreviewConversation: REAL helper --kill actually reaps the tree + confirms`,
  `${DYNAMIC}WS upstream (ws://127.0.0.1:<port>) connects + echoes a frame`,
]);
/** Proofs whose receipt is Bun's own report: the named files, every declared test passed exactly once. */
const BUN_REPORT_PROOFS: Readonly<Record<string, { readonly files: readonly string[]; readonly tests: readonly string[] }>> = {
  namespace: { files: [RUNNER_ISOLATION_PROOF_FILE], tests: RUNNER_ISOLATION_PROOF_TESTS },
  "preview-isolation": { files: proofBoundTests("preview-isolation"), tests: PREVIEW_ISOLATION_PROOF_TESTS },
};
/** What the retired host Stage 2 proof left in a receipt. Its presence means the wrong proof ran. */
const STAGE2_MARKERS = [/EZCORP_STAGE2_PROOF/, /stage2-raw-network-proof/, /mcp-netns-raw-socket-blocked/, /removing only nft makes the deny assertion fail/];

function fail(message: string): never { throw new Error(`production proof receipt rejected: ${message}`); }
function containsPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
function canonicalImageId(value: string, field: string): string {
  const canonical = value.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(canonical)) fail(`${field} must be a full sha256 image ID`);
  return canonical;
}
function parseFields(text: string, label: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1 || separator !== line.lastIndexOf("=")) fail(`${label} has malformed field`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[a-z_]+$/.test(key) || value.length === 0 || fields.has(key)) fail(`${label} has duplicate or invalid field ${key}`);
    fields.set(key, value);
  }
  return fields;
}
function requireField(fields: Map<string, string>, key: string, expected: string, label: string): void {
  if (fields.get(key) !== expected) fail(`${label} ${key} does not match`);
}
function parseSummary(text: string, shard: string): SummaryRow[] {
  const lines = text.trimEnd().split("\n");
  if (lines.shift() !== SUMMARY_HEADER || lines.length === 0) fail(`${shard} summary has an invalid header or no rows`);
  const expected = PRODUCTION_PROOF_SHARDS.find((candidate) => candidate.shard === shard)!.proofs.map(({ name }) => name);
  const rows: SummaryRow[] = [];
  for (const [index, line] of lines.entries()) {
    const columns = line.split("\t");
    if (columns.length !== 6) fail(`${shard} summary has a malformed row`);
    const [proof, exit, startedAt, finishedAt, durationMs, receipt] = columns;
    if (!proof || !exit || !startedAt || !finishedAt || !durationMs || !receipt) fail(`${shard} summary has an empty value`);
    if (proof !== expected[index]) fail(`${shard} summary has unknown, duplicate, or out-of-order proof ${proof}`);
    if (receipt !== proof || receipt.includes("/") || basename(receipt) !== receipt) fail(`${shard} proof ${proof} has an unsafe receipt path`);
    if (!/^0$/.test(exit)) fail(`${shard} proof ${proof} did not succeed (exit ${exit})`);
    if (!/^\d+$/.test(durationMs) || !Number.isSafeInteger(Number(durationMs))) fail(`${shard} proof ${proof} has an invalid duration`);
    const started = Date.parse(startedAt);
    const finished = Date.parse(finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) fail(`${shard} proof ${proof} has invalid timestamps`);
    if (Number(durationMs) !== finished - started) fail(`${shard} proof ${proof} duration does not match timestamps`);
    if (rows.length > 0 && Date.parse(rows.at(-1)!.finishedAt) > started) fail(`${shard} summary proofs overlap`);
    rows.push({ proof, exit: Number(exit), startedAt, finishedAt, durationMs: Number(durationMs), receipt });
  }
  if (expected.length !== rows.length) fail(`${shard} summary is missing proof ${expected.slice(rows.length).join(", ")}`);
  return rows;
}
async function assertRegularTree(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => fail(`${label} is missing`));
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(`${label} has an unsafe file type`);
  if (stat.isFile()) return;
  for (const entry of await readdir(path)) await assertRegularTree(join(path, entry), `${label}/${entry}`);
}
async function assertRegularFile(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch(() => fail(`${label} is missing`));
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} is not a regular file`);
}
function parseLauncherFields(text: string, label: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const matches = [...line.matchAll(/(?:^|\s)([a-z_]+)=/g)];
    if (matches.length === 0 || matches[0]!.index !== 0) fail(`${label} has malformed field`);
    for (const [index, match] of matches.entries()) {
      const key = match[1]!;
      const valueStart = match.index! + match[0].length;
      const valueEnd = matches[index + 1]?.index ?? line.length;
      const value = line.slice(valueStart, valueEnd).trim();
      if (value.length === 0 || fields.has(key)) fail(`${label} has duplicate or invalid field ${key}`);
      fields.set(key, value);
    }
  }
  return fields;
}
function isCandidateLauncher(proof: string, nested: string): boolean {
  return !(proof === "historical-upgrade" && nested === "upgrade/seed-previous") && !(proof === "legacy-adoption" && nested === "legacy/seed");
}
/**
 * A Bun-report receipt (namespace, preview-isolation) is Bun's own report of
 * the proof's test files. It must name exactly those files, list every
 * declared test exactly once as passed (so a skipped live arm, a failure, or
 * an extra test rejects), and end with the exact summary for that count.
 */
async function assertBunReportEvidence(proof: string, controllerLog: string): Promise<void> {
  const { files: expectedFiles, tests } = BUN_REPORT_PROOFS[proof]!;
  const output = Bun.stripANSI(await readFile(controllerLog, "utf8"));
  if (STAGE2_MARKERS.some(marker => marker.test(output))) fail(`${proof} controller is a retired Stage 2 receipt`);
  const files = [...output.matchAll(/^(?:::group::)?(\S+\.test\.ts):$/gm)].map(match => match[1]!).sort();
  if (files.join("\n") !== [...expectedFiles].sort().join("\n")) fail(`${proof} controller must report exactly ${expectedFiles.join(", ")}`);
  const reported = [...output.matchAll(/^\((\w+)\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(([, status, name]) => ({ status, name: name! }));
  for (const { status, name } of reported) {
    if (!tests.includes(name)) fail(`${proof} controller reports an unexpected test: ${name}`);
    if (status !== "pass") fail(`${proof} controller test did not pass (${status}): ${name}`);
  }
  for (const name of tests) if (reported.filter(entry => entry.name === name).length !== 1) fail(`${proof} controller is missing test: ${name}`);
  const count = tests.length;
  const across = expectedFiles.length === 1 ? "1 file." : `${expectedFiles.length} files.`;
  const summary = [...output.matchAll(/^\s*(\d+) (pass|fail|skip|todo)$/gm)].map(([, value, kind]) => `${value} ${kind}`).join(",");
  if (summary !== `${count} pass,0 fail` || !output.includes(`Ran ${count} tests across ${across}`)) fail(`${proof} controller summary is not exactly ${count} pass and 0 fail`);
}
async function assertLauncherReceipts(artifact: string, row: SummaryRow, revision: string, expectedImageId: string): Promise<void> {
  for (const nested of CLEANUP_RECEIPTS[row.proof] ?? fail(`no cleanup declaration for ${row.proof}`)) {
    const root = join(artifact, row.receipt, nested);
    const commandLog = join(root, "command.log");
    const provenancePath = join(root, "provenance.txt");
    await assertRegularFile(commandLog, `${row.proof}/${nested}/command.log`);
    await assertRegularFile(provenancePath, `${row.proof}/${nested}/provenance.txt`);
    const log = parseFields(await readFile(commandLog, "utf8"), `${row.proof} ${nested} command log`);
    for (const key of ["command_exit", "app_log_exit", "owned_cleanup_exit", "verifier_cleanup_exit"]) requireField(log, key, "0", `${row.proof} ${nested}`);
    const provenance = parseLauncherFields(await readFile(provenancePath, "utf8"), `${row.proof} ${nested} provenance`);
    requireField(provenance, "launcher_source", revision, `${row.proof} ${nested} launcher provenance`);
    const imageId = canonicalImageId(provenance.get("image_id") ?? "", `${row.proof} ${nested} image_id`);
    const imageRevision = provenance.get("revision") ?? "";
    if (isCandidateLauncher(row.proof, nested)) {
      if (!/^[0-9a-f]{40}$/.test(imageRevision) || imageId !== expectedImageId || imageRevision !== revision) fail(`${row.proof} ${nested} candidate launcher provenance does not match`);
    } else if (imageRevision !== "<no value>" && !/^[0-9a-f]{40}$/.test(imageRevision)) {
      fail(`${row.proof} ${nested} archived launcher revision is invalid`);
    }
  }
}
async function copyRegularTree(source: string, target: string): Promise<void> {
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(`unsafe source path ${source}`);
  if (stat.isFile()) { await copyFile(source, target); await chmod(target, stat.mode & 0o777); return; }
  await mkdir(target, { recursive: true, mode: stat.mode & 0o777 });
  for (const entry of await readdir(source)) await copyRegularTree(join(source, entry), join(target, entry));
}

export async function verifyShippingProductionResults(inputRoot: string, revision: string, expectedImageId: string, outputRoot: string): Promise<readonly VerifiedShard[]> {
  if (!/^[0-9a-f]{40}$/.test(revision)) fail("revision must be a full 40-hex SHA");
  const expectedCanonical = canonicalImageId(expectedImageId, "expected image ID");
  const input = resolve(inputRoot);
  const output = resolve(outputRoot);
  if (containsPath(input, output) || containsPath(output, input)) fail("input and output roots must not overlap");
  const outputStat = await lstat(output).catch(() => null);
  if (outputStat && (outputStat.isSymbolicLink() || !outputStat.isDirectory() || (await readdir(output)).length !== 0)) fail("output root must be absent or an empty regular directory");
  await assertRegularTree(input, "input root");
  const expectedArtifacts = new Map(PRODUCTION_PROOF_SHARDS.map(({ shard }) => [`production-proof-${shard}`, shard]));
  const entries = (await readdir(input, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name));
  if (entries.length !== expectedArtifacts.size) fail("input root does not contain exactly five artifacts");
  const verified: VerifiedShard[] = [];
  for (const entry of entries) {
    const shard = expectedArtifacts.get(entry.name);
    if (!shard || !entry.isDirectory() || entry.isSymbolicLink()) fail(`unknown or unsafe artifact ${entry.name}`);
    const artifact = join(input, entry.name);
    const provenance = parseFields(await readFile(join(artifact, "provenance.txt"), "utf8").catch(() => fail(`${shard} provenance is missing`)), `${shard} provenance`);
    requireField(provenance, "source_revision", revision, `${shard} provenance`);
    requireField(provenance, "shard", shard, `${shard} provenance`);
    const attested = canonicalImageId(provenance.get("expected_image_id") ?? "", `${shard} provenance expected_image_id`);
    if (attested !== expectedCanonical) fail(`${shard} provenance expected image ID does not match`);
    if (canonicalImageId(provenance.get("docker_image_id") ?? "", `${shard} Docker image ID`) !== expectedCanonical) fail(`${shard} Docker image ID does not match`);
    if (canonicalImageId(provenance.get("podman_image_id") ?? "", `${shard} Podman image ID`) !== expectedCanonical) fail(`${shard} Podman image ID does not match`);
    const rows = parseSummary(await readFile(join(artifact, "summary.tsv"), "utf8").catch(() => fail(`${shard} summary is missing`)), shard);
    for (const row of rows) {
      await assertRegularTree(join(artifact, row.receipt), `${shard}/${row.receipt}`);
      const controllerLog = join(artifact, row.receipt, "controller.log");
      await assertRegularFile(controllerLog, `${shard}/${row.receipt}/controller.log`);
      if (row.proof in BUN_REPORT_PROOFS) await assertBunReportEvidence(row.proof, controllerLog);
      await assertLauncherReceipts(artifact, row, revision, expectedCanonical);
    }
    verified.push({ shard, rows, artifact });
  }
  if (verified.length !== PRODUCTION_PROOF_SHARDS.length) fail("one or more expected artifacts are missing");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const rows = verified.flatMap(({ shard, rows: shardRows }) => shardRows.map((row) => ({ shard, ...row })));
  for (const { artifact, rows: shardRows } of verified) for (const row of shardRows) await copyRegularTree(join(artifact, row.receipt), join(output, row.receipt));
  await Bun.write(join(output, "summary.tsv"), `shard\t${SUMMARY_HEADER}\n${rows.map((row) => [row.shard, row.proof, row.exit, row.startedAt, row.finishedAt, row.durationMs, row.receipt].join("\t")).join("\n")}\n`);
  await Bun.write(join(output, "provenance.txt"), `source_revision=${revision}\nexpected_image_id=${expectedImageId}\nshards=${verified.map(({ shard }) => shard).sort().join(",")}\n`);
  const timing = { totalProofDurationMs: rows.reduce((total, row) => total + row.durationMs, 0), shards: verified.map(({ shard, rows: shardRows }) => ({ shard, proofDurationMs: shardRows.reduce((total, row) => total + row.durationMs, 0), proofs: shardRows.map(({ proof, durationMs }) => ({ proof, durationMs })) })) };
  await Bun.write(join(output, "timing.json"), `${JSON.stringify(timing, null, 2)}\n`);
  return verified;
}

if (import.meta.main) {
  const [input, revision, imageId, output, ...rest] = process.argv.slice(2);
  if (!input || !revision || !imageId || !output || rest.length !== 0) throw new Error("usage: verify-shipping-production-results.ts INPUT_ROOT REVISION EXPECTED_IMAGE_ID OUTPUT_ROOT");
  const verified = await verifyShippingProductionResults(input, revision, imageId, output);
  console.log(`verified ${verified.length} production proof artifacts`);
}
