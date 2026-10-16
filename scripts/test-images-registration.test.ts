/**
 * Every container image a CI workflow's services run is a value of scripts/test-images.json, and every value there is
 * pinned by digest (W4H-33, team-lead's scope addition). The PostgreSQL service of ci.yml and db-postgres.yml ran
 * pgvector/pgvector:pg15 by tag. The pin is the linux/amd64 platform manifest (OCI image manifest v1), the same form as
 * the existing "postgres" entry; the hosted runners are amd64.
 * The image-line parser and the pin rule are scripts/check-factory-deployment-locks.ts's (one rule for both trees).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { composeImages, type FactoryImageReference, unpinnedFactoryImages } from "./check-factory-deployment-locks";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");
const testImages = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/test-images.json"), "utf8")) as Record<string, string>;

/** Violations: a pin-file value that is not a digest pin, or a workflow image line that is not a pin-file value. */
function imageIssues(images: Record<string, string>, workflows: Record<string, string>): string[] {
  const pins = Object.entries(images).map(([key, reference], line) => ({ file: `test-images.json#${key}`, line, reference }));
  const lines: FactoryImageReference[] = Object.entries(workflows).flatMap(([file, text]) => composeImages(file, text));
  const values = new Set(Object.values(images));
  return [
    ...unpinnedFactoryImages(pins).map((entry) => `${entry.file}: not pinned by digest`),
    ...lines.filter((entry) => !values.has(entry.reference)).map((entry) => `${entry.file}:${entry.line}: ${entry.reference} is not a scripts/test-images.json value`),
  ];
}

const realWorkflows = (): Record<string, string> =>
  Object.fromEntries(readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml")).map((name) => [name, readFileSync(join(WORKFLOWS, name), "utf8")]));

describe("CI service images come from the digest-pinned test image list", () => {
  test("pgvector is pinned to the linux/amd64 platform manifest of pg15", () => {
    expect(testImages.pgvector).toBe("docker.io/pgvector/pgvector@sha256:9a169499888c9d75ad14d0401be64839d2c325f32e399098261589faff93d65c");
  });

  test("the three PostgreSQL service lines run exactly that pin, and no workflow image line or pin is a tag", () => {
    const workflows = realWorkflows();
    const pgvector = Object.entries(workflows).flatMap(([file, text]) => composeImages(file, text)).filter((entry) => entry.reference.includes("pgvector"));
    expect(pgvector.map(({ file, line }) => `${file}:${line}`).sort()).toEqual(["ci.yml:269", "db-postgres.yml:263", "db-postgres.yml:69"]);
    expect(pgvector.every((entry) => entry.reference === testImages.pgvector)).toBe(true);
    expect(imageIssues(testImages, workflows)).toEqual([]);
  });

  test("a tag back in one workflow line, or a tag in the pin file, is refused by name", () => {
    const workflows = realWorkflows();
    const tagged = { ...workflows, "ci.yml": workflows["ci.yml"]!.replace(testImages.pgvector!, "pgvector/pgvector:pg15") };
    expect(imageIssues(testImages, tagged)).toEqual(["ci.yml:269: pgvector/pgvector:pg15 is not a scripts/test-images.json value"]);
    expect(imageIssues({ ...testImages, pgvector: "docker.io/pgvector/pgvector:pg15" }, {})).toEqual(["test-images.json#pgvector: not pinned by digest"]);
  });
});
