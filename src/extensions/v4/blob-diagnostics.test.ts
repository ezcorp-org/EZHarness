import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReleaseBlobPresence, auditReleaseBlobStorage, boundedReleaseBlobAuditSample, FileBlobStore } from "./blobs";

const root = await mkdtemp(join(tmpdir(), "ezcorp-release-blob-audit-"));
const blobs = new FileBlobStore(root);
const absent = (letter: string) => letter.repeat(64);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("release blob audit distinguishes empty, mostly missing, and isolated missing stores without reading blob contents", async () => {
  const present = await blobs.put(new TextEncoder().encode("present"));
  const secondPresent = await blobs.put(new TextEncoder().encode("second present"));

  await expect(auditReleaseBlobPresence(blobs, [])).resolves.toEqual({ expected: 0, present: 0, missing: 0, condition: "healthy" });
  await expect(auditReleaseBlobPresence(blobs, [absent("a"), absent("b")])).resolves.toEqual({ expected: 2, present: 0, missing: 2, condition: "empty" });
  await expect(auditReleaseBlobPresence(blobs, [present, absent("c"), absent("d"), absent("e")])).resolves.toEqual({ expected: 4, present: 1, missing: 3, condition: "mostly_missing" });
  await expect(auditReleaseBlobPresence(blobs, [present, absent("f")])).resolves.toEqual({ expected: 2, present: 1, missing: 1, condition: "single_missing" });
  await expect(auditReleaseBlobPresence(blobs, [present, secondPresent, absent("0"), absent("1")])).resolves.toEqual({ expected: 4, present: 2, missing: 2, condition: "partially_missing" });
  await expect(auditReleaseBlobPresence(blobs, [present, secondPresent, absent("0"), absent("1"), absent("2")])).resolves.toEqual({ expected: 5, present: 2, missing: 3, condition: "mostly_missing" });
});

test("release blob storage warnings name the usable recovery without exposing release identities", async () => {
  const present = await blobs.put(new TextEncoder().encode("warning present"));
  const secondPresent = await blobs.put(new TextEncoder().encode("second warning present"));
  const thirdPresent = await blobs.put(new TextEncoder().encode("third warning present"));
  const messages: string[] = [];
  const report = async (sourceDigest: string, artifactDigest: string) => auditReleaseBlobStorage(blobs, [{ sourceDigest, artifactDigest }], (message) => messages.push(message));

  await expect(report(absent("3"), absent("4"))).resolves.toMatchObject({ condition: "empty" });
  await expect(report(present, absent("5"))).resolves.toMatchObject({ condition: "single_missing" });
  await expect(auditReleaseBlobStorage(blobs, [{ sourceDigest: present, artifactDigest: absent("6") }, { sourceDigest: absent("7"), artifactDigest: absent("8") }], (message) => messages.push(message))).resolves.toMatchObject({ condition: "mostly_missing" });
  await expect(auditReleaseBlobStorage(blobs, [{ sourceDigest: present, artifactDigest: absent("9") }, { sourceDigest: secondPresent, artifactDigest: absent("a") }, { sourceDigest: thirdPresent, artifactDigest: present }], (message) => messages.push(message))).resolves.toMatchObject({ condition: "partially_missing" });
  expect(messages).toEqual([
    expect.stringContaining("renamed or unmounted"),
    expect.stringContaining("One extension release blob"),
    expect.stringContaining("Most extension release blobs"),
    expect.stringContaining("Some extension release blobs"),
  ]);
  expect(messages.join("\n")).not.toContain(present);
});

test("release blob audit keeps one sentinel record and marks sampled warnings", async () => {
  expect(boundedReleaseBlobAuditSample(["first", "second", "sentinel"], 2)).toEqual({ records: ["first", "second"], partial: true });
  expect(boundedReleaseBlobAuditSample(["first", "second"], 2)).toEqual({ records: ["first", "second"], partial: false });
  const messages: string[] = [];
  const report = await auditReleaseBlobStorage(blobs, [{ sourceDigest: absent("c"), artifactDigest: absent("d") }], (message) => messages.push(message), { partial: true });
  expect(report).toMatchObject({ expected: 2, missing: 2, partial: true });
  expect(messages).toEqual([expect.stringContaining("in the audited sample")]);
  const sourceDigest = await blobs.put(new TextEncoder().encode("sample source"));
  const artifactDigest = await blobs.put(new TextEncoder().encode("sample artifact"));
  const completeSample = await auditReleaseBlobStorage(blobs, [{ sourceDigest, artifactDigest }], (message) => messages.push(message), { partial: true });
  expect(completeSample).toMatchObject({ condition: "healthy", partial: true });
  expect(messages[1]).toContain("audit is partial");
});
