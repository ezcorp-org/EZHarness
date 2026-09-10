#!/usr/bin/env bun
/**
 * Fail closed when an evidence Playwright run did not retain a captured PNG in
 * its blob ZIP. The visual workflow consumes this same artifact after CI, so a
 * list-only reporter must never make an evidence lane look successful.
 */
import { resolve } from "node:path";
import { parseReportJsonl, readBlobReports } from "./visual-evidence/build-manifest";

export async function assertEvidenceBlobHasPng(blobDir: string): Promise<number> {
  // A loose report.jsonl is insufficient: CI uploads ZIP shards from
  // web/blob-report, and this confirms that exact transport carries the shot.
  const reports = await readBlobReports(blobDir, { zipOnly: true });
  if (reports.length === 0) {
    throw new Error(`evidence run wrote no readable Playwright blob ZIP in ${blobDir}`);
  }

  const screenshots = reports.flatMap(parseReportJsonl);
  if (screenshots.length === 0) {
    throw new Error(`evidence blob ZIPs contain no inline PNG attachment in ${blobDir}`);
  }
  return screenshots.length;
}

async function main(): Promise<void> {
  const blobDir = process.argv[2];
  if (!blobDir) throw new Error("usage: bun scripts/check-playwright-evidence-blob.ts <blob-report-dir>");
  const screenshots = await assertEvidenceBlobHasPng(resolve(blobDir));
  console.log(`evidence blob: ${screenshots} PNG attachment(s) retained`);
}

if (import.meta.main) await main();
