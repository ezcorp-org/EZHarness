/**
 * W09h R4 on real PostgreSQL: add-factory-usage-nothing-launched-basis widens an existing installation's
 * no-operations basis check by one member, once, and removes nothing. Each case runs in its own database.
 */
import { factoryUsageBasisMigrationConformance } from "../../src/__tests__/helpers/factory-usage-basis-migration-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryUsageBasisMigrationConformance("PostgreSQL", setupFactoryPostgres);
