import { digestObject } from "../extensions/v4/blobs";
import type { FactoryChildAcceptanceResult } from "@ezcorp/factory-sdk";

/**
 * The acceptance-only result a `releaseMode: "none"` child returns.
 *
 * The shape, its validator, its builder, and the port schema that admits it all
 * live in `@ezcorp/factory-sdk`'s `child-acceptance.ts`, beside the reference
 * definitions that declare the port. One declaration is the point: the host
 * writes the value and `references.ts` declares the port, and a mirrored copy
 * in either tree would drift into a parent accepting a shape its own contract
 * never described.
 *
 * Re-exported here so a host caller reads one module for "what an
 * acceptance-only child returns and what authority it inherited".
 */
export {
  assertFactoryChildAcceptanceResult,
  FactoryChildAcceptanceError,
  factoryChildAcceptancePortSchema,
  factoryChildAcceptanceResult,
  FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
} from "@ezcorp/factory-sdk";
export type { FactoryChildAcceptanceResult } from "@ezcorp/factory-sdk";

/**
 * The release authority a run inherits from the subfactory nodes above it.
 *
 * Host-side rather than SDK-side on purpose: it is a fact about a run's
 * ancestry in the durable store, not about the value a child returns. The SDK
 * has no runs.
 *
 * `root` is a run with no parent binding. `none` wins over `authorized`
 * anywhere in the chain: a grandchild cannot be more authorized than the child
 * that composed it, and composing an acceptance-only child must not be a way
 * to reach a publishing grandchild.
 */
export type FactoryInheritedReleaseMode = "root" | "authorized" | "none";

/** The most restrictive of two inherited modes. */
export function narrowerFactoryReleaseMode(left: FactoryInheritedReleaseMode, right: FactoryInheritedReleaseMode): FactoryInheritedReleaseMode {
  if (left === "none" || right === "none") return "none";
  if (left === "authorized" || right === "authorized") return "authorized";
  return "root";
}

/**
 * A stable identity for one acceptance-only result, for receipts and traces.
 *
 * Stays host-side because it needs the v4 content digest, which is exactly the
 * kind of dependency the SDK's deterministic closure must not acquire.
 */
export function factoryChildAcceptanceDigest(result: FactoryChildAcceptanceResult): string {
  return `sha256:${digestObject(result)}`;
}
