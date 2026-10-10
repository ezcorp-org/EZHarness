import type { CompiledFactory } from "@ezcorp/factory-sdk";
import { decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import type {
  FactoryActivities,
  FactoryDefinitionPageReference,
  FactoryDefinitionSource,
  FactoryIdentity,
  FactoryManifestPage,
  ImmutableObjectReference,
} from "./contracts.ts";
import { MAX_DEFINITION_PAGES } from "./contracts.ts";
import { validateDefinitionSource, validateLoadedDefinitionPage, validateManifestPage } from "./validation.ts";

type DefinitionReader = Pick<FactoryActivities, "loadManifestPage" | "loadDefinitionPage">;

function sameReference(actual: ImmutableObjectReference, expected: ImmutableObjectReference): boolean {
  return actual.objectId === expected.objectId && actual.digest === expected.digest && actual.encodedBytes === expected.encodedBytes;
}

function assertManifestIdentity(page: FactoryManifestPage, source: FactoryDefinitionSource, expected: ImmutableObjectReference): void {
  validateManifestPage(page);
  if (!sameReference(page.self, expected)) throw new Error("factory manifest page identity does not match its immutable reference");
  if (page.definitionDigest !== source.definitionDigest || page.definitionEncodedBytes !== source.definitionEncodedBytes) {
    throw new Error("factory manifest page does not describe the requested definition");
  }
}

async function loadPageReferences(identity: FactoryIdentity, source: FactoryDefinitionSource, reader: DefinitionReader): Promise<FactoryDefinitionPageReference[]> {
  const pages: FactoryDefinitionPageReference[] = [];
  const visited = new Set<string>();
  let reference: ImmutableObjectReference | undefined = source.manifest;
  while (reference) {
    const key = `${reference.objectId}\0${reference.digest}`;
    if (visited.has(key)) throw new Error("factory manifest page chain contains a cycle");
    if (visited.size >= MAX_DEFINITION_PAGES) throw new Error(`factory manifest exceeds ${MAX_DEFINITION_PAGES} pages`);
    visited.add(key);
    const manifest = await reader.loadManifestPage({ ...identity, definition: source, page: reference });
    assertManifestIdentity(manifest, source, reference);
    pages.push(...manifest.pages);
    if (pages.length > MAX_DEFINITION_PAGES) throw new Error(`factory definition exceeds ${MAX_DEFINITION_PAGES} pages`);
    reference = manifest.next;
  }
  if (pages.length === 0) throw new Error("factory manifest must reference at least one definition page");
  pages.sort((left, right) => left.index - right.index);
  for (const [index, page] of pages.entries()) {
    if (page.index !== index) throw new Error("factory definition page indexes must be unique and contiguous");
  }
  return pages;
}

export async function loadCompiledFactory(identity: FactoryIdentity, source: FactoryDefinitionSource, reader: DefinitionReader): Promise<CompiledFactory> {
  validateDefinitionSource(source);
  const references = await loadPageReferences(identity, source, reader);
  let content = "";
  let encodedBytes = 0;
  for (const page of references) {
    const loaded = await reader.loadDefinitionPage({ ...identity, definitionDigest: source.definitionDigest, page });
    validateLoadedDefinitionPage(loaded, page);
    content += new TextDecoder("utf-8", { fatal: true }).decode(decodeFactoryPageBase64(loaded.contentBase64));
    encodedBytes += page.encodedBytes;
  }
  if (encodedBytes !== source.definitionEncodedBytes) throw new Error("factory definition byte count does not match its immutable manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("factory definition pages do not contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { digest?: unknown }).digest !== source.definitionDigest) {
    throw new Error("factory definition digest does not match the compiled definition");
  }
  return parsed as CompiledFactory;
}
