import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEvidenceBlobHasPng } from "../../scripts/check-playwright-evidence-blob";

const roots: string[] = [];

function pngAttachmentJsonl(): string {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `${JSON.stringify({
    method: "onAttach",
    params: {
      testId: "docs-a11y",
      attachments: [{ name: "api-docs", contentType: "image/png", base64: png.toString("base64") }],
    },
  })}\n`;
}

function blobDirectory(reportJsonl: string, zip = true): string {
  const root = mkdtempSync(join(tmpdir(), "evidence-blob-"));
  roots.push(root);
  const blobDir = join(root, "blob-report");
  mkdirSync(blobDir);
  const report = join(blobDir, "report.jsonl");
  writeFileSync(report, reportJsonl);
  if (zip) {
    const archive = join(blobDir, "report-chromium.zip");
    const result = Bun.spawnSync(["zip", "-q", archive, "report.jsonl"], { cwd: blobDir, stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    rmSync(report);
  }
  return blobDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("accepts an inline PNG attachment retained by a Playwright blob ZIP", async () => {
  await expect(assertEvidenceBlobHasPng(blobDirectory(pngAttachmentJsonl()))).resolves.toBe(1);
});

test("rejects a ZIP whose report has no PNG attachment", async () => {
  await expect(assertEvidenceBlobHasPng(blobDirectory('{"method":"onBegin","params":{}}\n'))).rejects.toThrow(
    "no inline PNG attachment",
  );
});

test("rejects a loose report because CI uploads blob ZIPs", async () => {
  await expect(assertEvidenceBlobHasPng(blobDirectory(pngAttachmentJsonl(), false))).rejects.toThrow(
    "no readable Playwright blob ZIP",
  );
});
