import type { ProcessSpawnPolicy } from "@ezcorp/extension-contract";

/**
 * Every factory guest may start processes. A factory guest is a package the
 * factory itself prepared and pinned by digest, not an installed extension,
 * and starting processes is part of its contract: the applied-control guest
 * (`python/guest.py`) spawns to measure what a child inherits. The runner
 * denies a start that names no policy, so every factory start names this one.
 */
export const FACTORY_GUEST_PROCESS_SPAWN: ProcessSpawnPolicy = "allow";
