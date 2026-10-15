import { digestBytes } from "../../extensions/v4/digest";
import { assertFactoryChildAcceptanceResult, type FactoryChildAcceptanceResult } from "../child-release-mode";
import { referenceCodeFilesDigest, type ReferenceCodeFile } from "../reference-code/snapshot";

export const REFERENCE_CATALOG_SCHEMA_VERSION = "factory.reference-catalog-request.v1" as const;

/** Where the catalog's own files live inside the candidate tree. */
export const REFERENCE_CATALOG_ROOT = "catalog";
export const REFERENCE_CATALOG_PAGE_PATH = `${REFERENCE_CATALOG_ROOT}/index.html`;
export const REFERENCE_CATALOG_IMAGE_PATH = `${REFERENCE_CATALOG_ROOT}/assets/catalog-tree.png`;
export const REFERENCE_CATALOG_DATA_PATH = `${REFERENCE_CATALOG_ROOT}/data/dataset-manifest.json`;

export const REFERENCE_CATALOG_LIMITS = Object.freeze({
  /** One accepted child artifact. The code pack's own per-file ceiling. */
  maxAssetBytes: 8 * 1024 * 1024,
  maxIssueLength: 4096,
});

/** The two protected claims the parent evaluates for itself. */
export const REFERENCE_CATALOG_CLAIM_IDS = Object.freeze(["catalog-build", "catalog-render"] as const);
export type ReferenceCatalogClaimId = (typeof REFERENCE_CATALOG_CLAIM_IDS)[number];

export type ReferenceCatalogErrorCode =
  | "reference_catalog_receipt_invalid"
  | "reference_catalog_bytes_unaccepted"
  | "reference_catalog_asset_oversize"
  | "reference_catalog_request_invalid"
  | "reference_catalog_tree_invalid";

export class ReferenceCatalogError extends Error {
  constructor(readonly code: ReferenceCatalogErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceCatalogError";
  }
}

/** One accepted child output, with the bytes the parent will embed. */
export interface ReferenceCatalogAcceptedChild {
  /** The child's typed acceptance-only receipt. */
  readonly receipt: unknown;
  /** The bytes themselves. Must hash to the digest the child's decision accepted. */
  readonly bytes: Uint8Array;
}

/** One file the candidate tree must carry, named by the bytes that were accepted. */
export interface ReferenceCatalogAsset {
  readonly path: string;
  /** `sha256:` plus 64 hex, recomputed from the bytes rather than copied. */
  readonly digest: string;
  readonly byteCount: number;
  readonly mediaType: string;
  /** The child acceptance decision that accepted exactly these bytes. */
  readonly childDecisionId: string;
  readonly childContractDigest: string;
}

export interface ReferenceCatalogRequest {
  readonly schemaVersion: typeof REFERENCE_CATALOG_SCHEMA_VERSION;
  /** The request text the code child receives. */
  readonly issue: string;
  /** Sorted by path. */
  readonly assets: readonly ReferenceCatalogAsset[];
  readonly requestDigest: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function acceptedArtifact(receipt: FactoryChildAcceptanceResult, label: string): { digest: string; mediaType: string } {
  const artifact = receipt.artifact as { digest?: unknown; mediaType?: unknown } | null;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest)
    || typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0) {
    throw new ReferenceCatalogError("reference_catalog_receipt_invalid", `${label} accepted no addressable artifact`);
  }
  return { digest: artifact.digest, mediaType: artifact.mediaType };
}

/**
 * Turns two accepted children into the exact asset set the candidate must carry.
 *
 * "Actual accepted bytes" is enforced here and nowhere else: the digest is
 * recomputed from the bytes in hand and compared with the digest the child's
 * sealed acceptance decision accepted. A caller that supplies different bytes
 * under a correct receipt is refused by name, which is the only reason this
 * function takes the bytes and the receipt separately rather than trusting a
 * single self-describing blob.
 */
export function prepareCatalogRequest(input: {
  readonly data: ReferenceCatalogAcceptedChild;
  readonly image: ReferenceCatalogAcceptedChild;
  readonly issue: string;
}): ReferenceCatalogRequest {
  if (input.issue.length === 0 || input.issue.length > REFERENCE_CATALOG_LIMITS.maxIssueLength) {
    throw new ReferenceCatalogError("reference_catalog_request_invalid", "the issue text is empty or beyond its bound");
  }
  const assets = ([
    ["data", input.data, REFERENCE_CATALOG_DATA_PATH],
    ["image", input.image, REFERENCE_CATALOG_IMAGE_PATH],
  ] as const).map(([label, child, path]) => {
    let receipt: FactoryChildAcceptanceResult;
    try { receipt = assertFactoryChildAcceptanceResult(child.receipt); }
    catch { throw new ReferenceCatalogError("reference_catalog_receipt_invalid", `${label} did not return an acceptance-only receipt`); }
    const accepted = acceptedArtifact(receipt, label);
    const bytes = Uint8Array.from(child.bytes);
    if (bytes.byteLength < 1 || bytes.byteLength > REFERENCE_CATALOG_LIMITS.maxAssetBytes) {
      throw new ReferenceCatalogError("reference_catalog_asset_oversize", `${label} is ${bytes.byteLength} bytes`);
    }
    const digest = `sha256:${digestBytes(bytes)}`;
    if (digest !== accepted.digest) {
      throw new ReferenceCatalogError("reference_catalog_bytes_unaccepted", `${label} bytes hash to ${digest}, not the accepted ${accepted.digest}`);
    }
    return Object.freeze({
      path, digest, byteCount: bytes.byteLength, mediaType: accepted.mediaType,
      childDecisionId: receipt.decisionId, childContractDigest: receipt.contractDigest,
    });
  }).sort((left, right) => (left.path < right.path ? -1 : 1));

  const request: Omit<ReferenceCatalogRequest, "requestDigest"> = {
    schemaVersion: REFERENCE_CATALOG_SCHEMA_VERSION,
    issue: input.issue,
    assets: Object.freeze(assets),
  };
  return Object.freeze({ ...request, requestDigest: `sha256:${digestBytes(new TextEncoder().encode(JSON.stringify(request)))}` });
}

/** Refuses a request whose seal does not match its own contents. */
export function assertCatalogRequest(value: ReferenceCatalogRequest): ReferenceCatalogRequest {
  const { requestDigest, ...rest } = value;
  if (value.schemaVersion !== REFERENCE_CATALOG_SCHEMA_VERSION || value.assets.length !== 2
    || `sha256:${digestBytes(new TextEncoder().encode(JSON.stringify(rest)))}` !== requestDigest) {
    throw new ReferenceCatalogError("reference_catalog_request_invalid", "the request seal does not match its contents");
  }
  return value;
}

const ESCAPES: ReadonlyMap<string, string> = new Map([["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]]);

/** HTML-escapes one value. The catalog renders child-supplied text, so this is not optional. */
export function escapeCatalogText(value: string): string {
  return [...value].map(character => ESCAPES.get(character) ?? character).join("");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The page, rendered from the request alone so the same request always yields the same bytes. */
export function renderCatalogPage(request: ReferenceCatalogRequest): string {
  const rows = request.assets.map(asset =>
    `    <tr><td>${escapeCatalogText(asset.path)}</td><td>${escapeCatalogText(asset.mediaType)}</td><td>${asset.byteCount}</td><td><code>${escapeCatalogText(asset.digest)}</code></td></tr>`,
  ).join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    "    <title>Accepted catalog</title>",
    '    <link rel="stylesheet" href="catalog.css" />',
    "  </head>",
    "  <body>",
    "    <h1>Accepted catalog</h1>",
    `    <p>${escapeCatalogText(request.issue)}</p>`,
    `    <img src="assets/catalog-tree.png" alt="${escapeCatalogText("The accepted catalog illustration")}" />`,
    "    <table>",
    "      <thead><tr><th>Path</th><th>Media type</th><th>Bytes</th><th>Digest</th></tr></thead>",
    "      <tbody>",
    rows,
    "      </tbody>",
    "    </table>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

const CATALOG_STYLESHEET = [
  "body { font-family: system-ui, sans-serif; margin: 2rem; }",
  "table { border-collapse: collapse; }",
  "td, th { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; }",
  "img { max-width: 32rem; }",
  "",
].join("\n");

/**
 * Embeds the accepted bytes into a complete candidate tree.
 *
 * The base tree is carried through unchanged; every catalog path is replaced
 * rather than merged, so the result is a whole tree and not a patch. The
 * accepted bytes go in verbatim — nothing re-encodes, resizes, or normalizes
 * them, because the digest the parent's own checks recompute is the digest the
 * child's acceptance decision accepted.
 */
export function buildReferenceCatalogCandidate(
  base: readonly ReferenceCodeFile[],
  request: ReferenceCatalogRequest,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): readonly ReferenceCodeFile[] {
  assertCatalogRequest(request);
  const files = new Map(base.map(file => [file.path, file] as const));
  for (const asset of request.assets) {
    const bytes = bytesByPath.get(asset.path);
    if (!bytes) throw new ReferenceCatalogError("reference_catalog_tree_invalid", `no bytes supplied for ${asset.path}`);
    if (`sha256:${digestBytes(bytes)}` !== asset.digest) {
      throw new ReferenceCatalogError("reference_catalog_bytes_unaccepted", `${asset.path} does not carry the accepted bytes`);
    }
    files.set(asset.path, { path: asset.path, mode: "100644", content: Uint8Array.from(bytes) });
  }
  files.set(REFERENCE_CATALOG_PAGE_PATH, { path: REFERENCE_CATALOG_PAGE_PATH, mode: "100644", content: utf8(renderCatalogPage(request)) });
  const stylesheet = `${REFERENCE_CATALOG_ROOT}/catalog.css`;
  files.set(stylesheet, { path: stylesheet, mode: "100644", content: utf8(CATALOG_STYLESHEET) });
  return Object.freeze([...files.values()].sort((left, right) => (left.path < right.path ? -1 : 1)));
}

/** One protected claim, in the shape the validator report carries. */
export interface ReferenceCatalogClaim {
  readonly id: ReferenceCatalogClaimId;
  readonly verdict: "PASS" | "FAIL";
  readonly decisive: true;
  readonly summary: string;
  readonly reasonCode: string;
}

function claim(id: ReferenceCatalogClaimId, ok: boolean, summary: string, reasonCode: string): ReferenceCatalogClaim {
  return Object.freeze({ id, verdict: ok ? "PASS" as const : "FAIL" as const, decisive: true as const, summary, reasonCode });
}

/**
 * The parent's own protected checks, recomputed from the candidate tree.
 *
 * Independent of whatever produced the tree: `catalog-build` re-hashes the
 * embedded bytes and compares them with the digests the children's acceptance
 * decisions accepted, and `catalog-render` re-renders the page from the
 * request and compares it byte for byte. A generator that wrote a resized
 * image, a truncated dataset, or a page naming a path it did not embed fails
 * one of them by name.
 *
 * A child's acceptance is an INPUT here. These claims are the parent's, and
 * the parent's acceptance decision is taken over them alone.
 */
export function referenceCatalogClaims(candidate: readonly ReferenceCodeFile[], request: ReferenceCatalogRequest): readonly ReferenceCatalogClaim[] {
  assertCatalogRequest(request);
  const byPath = new Map(candidate.map(file => [file.path, file] as const));
  const missing = request.assets.filter(asset => !byPath.has(asset.path));
  const mismatched = request.assets.filter(asset => {
    const file = byPath.get(asset.path);
    return file !== undefined && (`sha256:${digestBytes(file.content)}` !== asset.digest || file.content.byteLength !== asset.byteCount);
  });
  const build = claim(
    "catalog-build",
    missing.length === 0 && mismatched.length === 0,
    missing.length === 0 && mismatched.length === 0
      ? `every accepted artifact is embedded at its accepted digest (${request.assets.length})`
      : `missing: ${missing.map(asset => asset.path).join(", ") || "none"}; not the accepted bytes: ${mismatched.map(asset => asset.path).join(", ") || "none"}`,
    missing.length > 0 ? "asset-missing" : mismatched.length > 0 ? "asset-not-accepted" : "assets-embedded",
  );

  const page = byPath.get(REFERENCE_CATALOG_PAGE_PATH);
  const expected = utf8(renderCatalogPage(request));
  const rendered = page !== undefined && Buffer.from(page.content).equals(Buffer.from(expected));
  const render = claim(
    "catalog-render",
    rendered,
    rendered ? `the page renders exactly from the request (${expected.byteLength} bytes)` : page === undefined ? "the catalog page is absent" : "the catalog page is not the page this request renders",
    page === undefined ? "page-missing" : rendered ? "page-rendered" : "page-altered",
  );
  return Object.freeze([build, render]);
}

/** The identity of one evaluated candidate, for the evidence record. */
export function referenceCatalogCandidateDigest(candidate: readonly ReferenceCodeFile[]): string {
  return referenceCodeFilesDigest(candidate);
}
