import { defineExtension, serve } from "@ezcorp/sdk/v4";

/**
 * The reference S3 release adapter, as a real v4 package (W4H-28 P4).
 *
 * A release node names its adapter by package, version, export and DIGEST, and the installation's
 * declared release profile is keyed by that exact reference. The digest was a placeholder until now
 * (one hex character repeated), which no fleet could declare. This package is what the digest now
 * names: built by the product's guest-package path in the pinned runner image, its artifact digest
 * pinned in the SDK and locked beside it (`package.ts`).
 *
 * The package performs no publication. C04 keeps publication broker-only: the host's declared S3
 * profile writes the sealed records the acceptance decision froze. A guest that invokes the tool is
 * refused by name, so the package can never become a second, unaudited publication path.
 */

export const S3_RELEASE_ADAPTER_PACKAGE = "@ezcorp/s3-immutable-publish";
export const S3_RELEASE_ADAPTER_MANIFEST_NAME = "s3-immutable-publish";
export const S3_RELEASE_ADAPTER_VERSION = "1.0.0";
export const S3_RELEASE_ADAPTER_EXPORT = "publish";
export const S3_RELEASE_ADAPTER_HOST_ONLY = "factory_release_adapter_host_only";

export const S3_RELEASE_ADAPTER_MANIFEST = {
  schemaVersion: 4 as const,
  name: S3_RELEASE_ADAPTER_MANIFEST_NAME,
  version: S3_RELEASE_ADAPTER_VERSION,
  author: { name: "EZCorp" },
  description: "The reference S3 immutable publication adapter. The installation's declared release profile publishes; this package names it.",
  permissions: {},
  tools: [{ name: S3_RELEASE_ADAPTER_EXPORT, description: "Refuses: the host's declared S3 release profile performs the publication.", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
};

/** The one tool. Publication is the host profile's; a guest call is refused by name. */
export async function publish(): Promise<never> {
  throw new Error(`${S3_RELEASE_ADAPTER_HOST_ONLY}: the installation's declared S3 release profile performs this publication`);
}

export const S3_RELEASE_ADAPTER_EXTENSION = defineExtension({ manifest: S3_RELEASE_ADAPTER_MANIFEST, tools: { [S3_RELEASE_ADAPTER_EXPORT]: publish } });

/** Serving happens only when this module IS the guest process, never when a test imports it. */
export const S3_RELEASE_ADAPTER_SERVED = import.meta.main ? await serve(S3_RELEASE_ADAPTER_EXTENSION) : undefined;
