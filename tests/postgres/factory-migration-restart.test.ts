import { factoryMigrationRestartConformance } from "../../src/__tests__/helpers/factory-migration-restart-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryMigrationRestartConformance(setupFactoryPostgres);
