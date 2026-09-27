import { factoryUsageEpochConformance } from "../../src/__tests__/helpers/factory-usage-epoch-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryUsageEpochConformance(setupFactoryPostgres);
