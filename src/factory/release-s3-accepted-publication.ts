/**
 * What an S3 publication resolves from, with no store, no client and no database (W4H-28): the
 * accepted-publication record a candidate names. Split out of `release-s3-scope.ts`, which
 * re-exports it and owns the rules, so a sandboxed guest (the reference-code freeze) can build the
 * record its release will be resolved from.
 */

export const FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION = "factory.s3-accepted-publication.v1";

/** One accepted output the protected candidate names for publication. */
export interface FactoryS3AcceptedFile {
  /** The published path under the operation directory. */
  readonly name: string;
  /** The sealed material this file's bytes come from. */
  readonly objectName: string;
  readonly version: number;
}

/**
 * The protected accepted candidate an S3 publication resolves from.
 *
 * The caller chooses where a set lands through `requestedDestination`; this
 * value, which the acceptance decision froze, chooses what is in it.
 */
export interface FactoryS3AcceptedPublication {
  readonly schemaVersion: typeof FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION;
  /** The gateway operation the producing attempt wrote its materials under. */
  readonly materialOperationId: string;
  /** The material holding the accepted candidate manifest itself. */
  readonly candidateObjectName: string;
  readonly candidateVersion: number;
  readonly files: readonly FactoryS3AcceptedFile[];
}
