import { expect, test } from "bun:test";
import { digestBytes } from "../../extensions/v4/digest";
import { factoryChildAcceptanceResult } from "../child-release-mode";
import { referenceCodeLaunchRepository } from "../reference-code/fixtures";
import type { ReferenceCodeFile } from "../reference-code/snapshot";
import {
  assertCatalogRequest,
  buildReferenceCatalogCandidate,
  escapeCatalogText,
  prepareCatalogRequest,
  referenceCatalogCandidateDigest,
  referenceCatalogClaims,
  ReferenceCatalogError,
  REFERENCE_CATALOG_DATA_PATH,
  REFERENCE_CATALOG_IMAGE_PATH,
  REFERENCE_CATALOG_LIMITS,
  REFERENCE_CATALOG_PAGE_PATH,
  REFERENCE_CATALOG_SCHEMA_VERSION,
  renderCatalogPage,
  type ReferenceCatalogRequest,
} from "./catalog";

const dataBytes = new TextEncoder().encode(JSON.stringify({ rowCount: 3, total: "400", categories: { alpha: "150", beta: "250" } }));
// A real PNG signature plus a payload, so the fixture is bytes rather than text.
const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0x2a)]);

const digest = (bytes: Uint8Array): string => `sha256:${digestBytes(bytes)}`;

function child(bytes: Uint8Array, mediaType: string, decisionId: string) {
  return {
    receipt: factoryChildAcceptanceResult({
      decisionId,
      contractDigest: `sha256:${"c".repeat(64)}`,
      candidateDigest: digest(bytes),
      evidenceSetDigest: `sha256:${"e".repeat(64)}`,
      artifact: { digest: digest(bytes), mediaType, storage: "immutable://accepted" },
    }),
    bytes,
  };
}

const issue = "Build a static catalog page from the accepted dataset manifest and the accepted illustration.";

function request(): ReferenceCatalogRequest {
  return prepareCatalogRequest({
    data: child(dataBytes, "application/json", "decision-data"),
    image: child(imageBytes, "image/png", "decision-image"),
    issue,
  });
}

function bytesByPath(): Map<string, Uint8Array> {
  return new Map([[REFERENCE_CATALOG_DATA_PATH, dataBytes], [REFERENCE_CATALOG_IMAGE_PATH, imageBytes]]);
}

function candidate(): readonly ReferenceCodeFile[] {
  return buildReferenceCatalogCandidate(referenceCodeLaunchRepository(), request(), bytesByPath());
}

test("the request names exactly the two accepted artifacts, sorted and sealed", () => {
  const prepared = request();
  expect(prepared.schemaVersion).toBe(REFERENCE_CATALOG_SCHEMA_VERSION);
  expect(prepared.assets.map(asset => asset.path)).toEqual([REFERENCE_CATALOG_IMAGE_PATH, REFERENCE_CATALOG_DATA_PATH].sort());
  expect(prepared.assets.find(asset => asset.path === REFERENCE_CATALOG_DATA_PATH)).toMatchObject({
    digest: digest(dataBytes), byteCount: dataBytes.byteLength, mediaType: "application/json", childDecisionId: "decision-data",
  });
  expect(prepared.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(assertCatalogRequest(prepared)).toBe(prepared);
  expect(prepareCatalogRequest({ data: child(dataBytes, "application/json", "decision-data"), image: child(imageBytes, "image/png", "decision-image"), issue }).requestDigest).toBe(prepared.requestDigest);
});

test("bytes that are not the accepted bytes are refused by name", () => {
  const wrong = new TextEncoder().encode("a different dataset");
  expect(() => prepareCatalogRequest({ data: { receipt: child(dataBytes, "application/json", "d").receipt, bytes: wrong }, image: child(imageBytes, "image/png", "i"), issue }))
    .toThrow(/reference_catalog_bytes_unaccepted/);
});

test("a receipt that is not an acceptance-only result, or names no addressable artifact, is refused", () => {
  const releaseReceipt = { provider: "s3", bucket: "accepted", confirmed: true };
  expect(() => prepareCatalogRequest({ data: { receipt: releaseReceipt, bytes: dataBytes }, image: child(imageBytes, "image/png", "i"), issue }))
    .toThrow(/reference_catalog_receipt_invalid/);
  const unaddressable = factoryChildAcceptanceResult({
    decisionId: "d", contractDigest: `sha256:${"c".repeat(64)}`, candidateDigest: `sha256:${"d".repeat(64)}`,
    evidenceSetDigest: `sha256:${"e".repeat(64)}`, artifact: { storage: "immutable://accepted" },
  });
  expect(() => prepareCatalogRequest({ data: { receipt: unaddressable, bytes: dataBytes }, image: child(imageBytes, "image/png", "i"), issue }))
    .toThrow(/reference_catalog_receipt_invalid/);
});

test("an empty asset, an oversized asset, and a bad issue are all bounded refusals", () => {
  expect(() => prepareCatalogRequest({ data: { receipt: child(dataBytes, "application/json", "d").receipt, bytes: new Uint8Array(0) }, image: child(imageBytes, "image/png", "i"), issue }))
    .toThrow(/reference_catalog_asset_oversize/);
  const huge = new Uint8Array(REFERENCE_CATALOG_LIMITS.maxAssetBytes + 1);
  expect(() => prepareCatalogRequest({ data: { receipt: child(huge, "application/json", "d").receipt, bytes: huge }, image: child(imageBytes, "image/png", "i"), issue }))
    .toThrow(/reference_catalog_asset_oversize/);
  for (const bad of ["", "x".repeat(REFERENCE_CATALOG_LIMITS.maxIssueLength + 1)]) {
    expect(() => prepareCatalogRequest({ data: child(dataBytes, "application/json", "d"), image: child(imageBytes, "image/png", "i"), issue: bad }))
      .toThrow(/reference_catalog_request_invalid/);
  }
});

test("a resealed or reshaped request is refused", () => {
  const prepared = request();
  expect(() => assertCatalogRequest({ ...prepared, issue: "a different issue" })).toThrow(ReferenceCatalogError);
  expect(() => assertCatalogRequest({ ...prepared, assets: [prepared.assets[0]!] })).toThrow(ReferenceCatalogError);
  expect(() => assertCatalogRequest({ ...prepared, schemaVersion: "factory.reference-catalog-request.v2" as typeof REFERENCE_CATALOG_SCHEMA_VERSION })).toThrow(ReferenceCatalogError);
});

test("the candidate carries the accepted bytes verbatim and keeps every base file", () => {
  const base = referenceCodeLaunchRepository();
  const tree = candidate();
  for (const file of base) {
    const carried = tree.find(entry => entry.path === file.path);
    expect(Buffer.from(carried!.content).equals(Buffer.from(file.content)), file.path).toBe(true);
  }
  const embeddedImage = tree.find(file => file.path === REFERENCE_CATALOG_IMAGE_PATH)!;
  expect(Buffer.from(embeddedImage.content).equals(Buffer.from(imageBytes))).toBe(true);
  expect(embeddedImage.mode).toBe("100644");
  expect(tree.map(file => file.path)).toEqual([...tree.map(file => file.path)].sort());
  expect(tree.some(file => file.path === REFERENCE_CATALOG_PAGE_PATH)).toBe(true);
  expect(referenceCatalogCandidateDigest(tree)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(referenceCatalogCandidateDigest(tree)).toBe(referenceCatalogCandidateDigest(candidate()));
});

test("the builder refuses bytes it was not given, and bytes that are not the accepted ones", () => {
  expect(() => buildReferenceCatalogCandidate(referenceCodeLaunchRepository(), request(), new Map())).toThrow(/reference_catalog_tree_invalid/);
  const swapped = bytesByPath();
  swapped.set(REFERENCE_CATALOG_IMAGE_PATH, new TextEncoder().encode("not the accepted image"));
  expect(() => buildReferenceCatalogCandidate(referenceCodeLaunchRepository(), request(), swapped)).toThrow(/reference_catalog_bytes_unaccepted/);
});

test("both protected claims pass for a candidate built from the request", () => {
  const claims = referenceCatalogClaims(candidate(), request());
  expect(claims.map(value => value.id)).toEqual(["catalog-build", "catalog-render"]);
  for (const value of claims) expect(value, value.id).toMatchObject({ verdict: "PASS", decisive: true });
  expect(claims[0]!.reasonCode).toBe("assets-embedded");
  expect(claims[1]!.reasonCode).toBe("page-rendered");
});

test("a missing asset, a swapped asset, and an altered page each fail one claim by name", () => {
  const prepared = request();
  const whole = candidate();

  const withoutImage = whole.filter(file => file.path !== REFERENCE_CATALOG_IMAGE_PATH);
  const missing = referenceCatalogClaims(withoutImage, prepared);
  expect(missing[0]).toMatchObject({ id: "catalog-build", verdict: "FAIL", reasonCode: "asset-missing" });
  expect(missing[0]!.summary).toContain(REFERENCE_CATALOG_IMAGE_PATH);
  expect(missing[1]).toMatchObject({ verdict: "PASS" });

  const resized = whole.map(file => (file.path === REFERENCE_CATALOG_IMAGE_PATH ? { ...file, content: imageBytes.slice(0, 16) } : file));
  expect(referenceCatalogClaims(resized, prepared)[0]).toMatchObject({ id: "catalog-build", verdict: "FAIL", reasonCode: "asset-not-accepted" });

  const altered = whole.map(file => (file.path === REFERENCE_CATALOG_PAGE_PATH ? { ...file, content: new TextEncoder().encode("<html>a hand-written page</html>") } : file));
  expect(referenceCatalogClaims(altered, prepared)[1]).toMatchObject({ id: "catalog-render", verdict: "FAIL", reasonCode: "page-altered" });

  const pageless = whole.filter(file => file.path !== REFERENCE_CATALOG_PAGE_PATH);
  expect(referenceCatalogClaims(pageless, prepared)[1]).toMatchObject({ id: "catalog-render", verdict: "FAIL", reasonCode: "page-missing" });
});

test("the page escapes child-supplied text rather than rendering it", () => {
  const hostile = `A "tree" & <script>alert('x')</script>`;
  const prepared = prepareCatalogRequest({ data: child(dataBytes, "application/json", "d"), image: child(imageBytes, "image/png", "i"), issue: hostile });
  const page = renderCatalogPage(prepared);
  expect(page).not.toContain("<script>");
  expect(page).toContain("&lt;script&gt;");
  expect(page).toContain("&quot;tree&quot;");
  expect(page).toContain("&amp;");
  expect(escapeCatalogText("a'b")).toBe("a&#39;b");
  expect(escapeCatalogText("plain")).toBe("plain");
});

test("the page names every asset by its exact path, media type, and digest", () => {
  const prepared = request();
  const page = renderCatalogPage(prepared);
  for (const asset of prepared.assets) {
    expect(page, asset.path).toContain(asset.path);
    expect(page, asset.path).toContain(asset.digest);
    expect(page, asset.path).toContain(String(asset.byteCount));
  }
});
