import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { loadCompiledFactory } from "../src/definition-pages.ts";

const digest = (character) => `sha256:${character.repeat(64)}`;
const identity = { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "build" };
const reference = (objectId, character, encodedBytes = 1) => ({ objectId, digest: digest(character), encodedBytes });

function fixture() {
  const definitionDigest = digest("a");
  const content = JSON.stringify({ digest: definitionDigest, partitions: [] });
  const cut = Math.floor(content.length / 2);
  const chunks = [content.slice(0, cut), content.slice(cut)];
  const pages = chunks.map((chunk, index) => ({ ...reference(`page-${index}`, index === 0 ? "b" : "c", Buffer.byteLength(chunk)), index }));
  const root = reference("manifest-0", "d");
  const next = reference("manifest-1", "e");
  const source = { definitionDigest, definitionEncodedBytes: Buffer.byteLength(content), manifest: root };
  const manifests = new Map([
    [root.objectId, { schemaVersion: "factory.manifest-page.v1", definitionDigest, definitionEncodedBytes: source.definitionEncodedBytes, self: root, pages: [pages[1]], next }],
    [next.objectId, { schemaVersion: "factory.manifest-page.v1", definitionDigest, definitionEncodedBytes: source.definitionEncodedBytes, self: next, pages: [pages[0]] }],
  ]);
  const reader = {
    loadManifestPage: async ({ page }) => structuredClone(manifests.get(page.objectId)),
    loadDefinitionPage: async ({ page }) => ({ index: page.index, objectId: page.objectId, digest: page.digest, contentBase64: encodeFactoryPageBase64(new TextEncoder().encode(chunks[page.index])) }),
  };
  return { chunks, content, definitionDigest, manifests, next, pages, reader, root, source };
}

describe("paged compiled factory loading", () => {
  it("loads a hierarchical manifest through recorded, ordered pages", async () => {
    const value = fixture();
    assert.deepEqual(await loadCompiledFactory(identity, value.source, value.reader), JSON.parse(value.content));
  });

  it("rejects manifest identity, definition, cycles, and page-count faults", async () => {
    const wrongSelf = fixture();
    wrongSelf.manifests.get(wrongSelf.root.objectId).self = reference("wrong", "d");
    await assert.rejects(loadCompiledFactory(identity, wrongSelf.source, wrongSelf.reader), /identity/);

    const wrongDefinition = fixture();
    wrongDefinition.manifests.get(wrongDefinition.root.objectId).definitionDigest = digest("f");
    await assert.rejects(loadCompiledFactory(identity, wrongDefinition.source, wrongDefinition.reader), /requested definition/);

    const cycle = fixture();
    cycle.manifests.get(cycle.next.objectId).next = cycle.root;
    await assert.rejects(loadCompiledFactory(identity, cycle.source, cycle.reader), /cycle/);

    const noPages = fixture();
    noPages.manifests.get(noPages.root.objectId).pages = [];
    noPages.manifests.get(noPages.root.objectId).next = undefined;
    await assert.rejects(loadCompiledFactory(identity, noPages.source, noPages.reader), /at least one/);

    const tooMany = fixture();
    tooMany.manifests.get(tooMany.root.objectId).pages = Array.from({ length: 512 }, (_, index) => ({ ...reference(`first-${index}`, "b"), index }));
    tooMany.manifests.get(tooMany.next.objectId).pages = [{ ...reference("overflow", "c"), index: 512 }];
    await assert.rejects(loadCompiledFactory(identity, tooMany.source, tooMany.reader), /definition exceeds 512/);

    let manifestIndex = 0;
    const longSource = { definitionDigest: digest("a"), definitionEncodedBytes: 1, manifest: reference("manifest-0", "b") };
    const longReader = {
      loadManifestPage: async ({ page }) => ({ schemaVersion: "factory.manifest-page.v1", definitionDigest: longSource.definitionDigest, definitionEncodedBytes: 1, self: page, pages: [], next: reference(`manifest-${++manifestIndex}`, "b") }),
      loadDefinitionPage: async () => { throw new Error("not reached"); },
    };
    await assert.rejects(loadCompiledFactory(identity, longSource, longReader), /manifest exceeds 512/);
  });

  it("rejects discontinuous pages, byte drift, invalid JSON, and digest drift", async () => {
    const discontinuous = fixture();
    discontinuous.manifests.get(discontinuous.next.objectId).pages[0].index = 2;
    await assert.rejects(loadCompiledFactory(identity, discontinuous.source, discontinuous.reader), /unique and contiguous/);

    const byteDrift = fixture();
    byteDrift.source.definitionEncodedBytes += 1;
    for (const manifest of byteDrift.manifests.values()) manifest.definitionEncodedBytes += 1;
    await assert.rejects(loadCompiledFactory(identity, byteDrift.source, byteDrift.reader), /byte count/);

    const invalid = fixture();
    invalid.reader.loadDefinitionPage = async ({ page }) => ({ index: page.index, objectId: page.objectId, digest: page.digest, contentBase64: encodeFactoryPageBase64(new TextEncoder().encode(page.index === 0 ? "{".repeat(page.encodedBytes) : "x".repeat(page.encodedBytes))) });
    await assert.rejects(loadCompiledFactory(identity, invalid.source, invalid.reader), /valid JSON/);

    for (const parsed of [null, [], { digest: digest("f") }]) {
      const wrong = fixture();
      const content = JSON.stringify(parsed);
      const page = { ...reference("only", "b", Buffer.byteLength(content)), index: 0 };
      wrong.source.definitionEncodedBytes = page.encodedBytes;
      wrong.manifests.get(wrong.root.objectId).definitionEncodedBytes = page.encodedBytes;
      wrong.manifests.get(wrong.root.objectId).pages = [page];
      wrong.manifests.get(wrong.root.objectId).next = undefined;
      wrong.reader.loadDefinitionPage = async () => ({ index: 0, objectId: page.objectId, digest: page.digest, contentBase64: encodeFactoryPageBase64(new TextEncoder().encode(content)) });
      await assert.rejects(loadCompiledFactory(identity, wrong.source, wrong.reader), /digest/);
    }
  });
});
