/** Runs the one C03 conformance suite against PGlite from the canonical Bun pool. */
export async function registerPgliteFactoryPoolConformance(): Promise<void> {
  process.env.FACTORY_POOL_ENGINE = "pglite";
  await import("../../../tests/postgres/factory-pool.test");
}
