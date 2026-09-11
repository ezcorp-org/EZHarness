#!/usr/bin/env bun
/** Verify isolated production-proof artifacts before publishing one receipt. */
import { copyFile, lstat, mkdir, readdir, readFile, chmod } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PRODUCTION_PROOF_SHARDS } from "./production-proof-plan.ts";

type SummaryRow = { proof: string; exit: number; startedAt: string; finishedAt: string; durationMs: number; receipt: string };
type VerifiedShard = { shard: string; rows: SummaryRow[]; artifact: string };

const SUMMARY_HEADER = "proof\texit\tstarted_at\tfinished_at\tduration_ms\treceipt";
const CLEANUP_RECEIPTS: Readonly<Record<string, readonly string[]>> = {
  "file-organizer": ["runtime"], embeddings: ["runtime"], runtime: ["runtime"], delivery: ["runtime"],
  revocation: ["runtime"], "runtime-resources": ["runtime"],
  "historical-upgrade": ["upgrade/seed-previous", "upgrade/assert-candidate", "upgrade/assert-restore"],
  "legacy-adoption": ["legacy/seed", "legacy/adopt"], namespace: [],
};
const NAMESPACE_TESTS = [
  "the production namespace blocks direct TCP; removing only nft makes the deny assertion fail",
  "the launcher removes seeded IPv6 while IPv4 proxy traffic works; omitting only the disable writes fails",
  "four workers complete 400 real proxy requests over five minutes and leave no owned containers",
  "a killed worker fails the same controller despite low connection counts",
];

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
async function assertNamespaceEvidence(controllerLog: string): Promise<void> {
  const output = Bun.stripANSI(await readFile(controllerLog, "utf8"));
  if (!/\b4 pass\b/.test(output) || !/\b0 fail\b/.test(output)) fail("namespace controller does not contain a successful native Bun summary");
  if (/\bskipp?(?:ed|ing)?\b/i.test(output)) fail("namespace controller contains skipped tests");
  for (const name of NAMESPACE_TESTS) if (!output.includes(name)) fail(`namespace controller is missing real test: ${name}`);
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
      if (row.proof === "namespace") await assertNamespaceEvidence(controllerLog);
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
