import { factoryRecordsConformance } from "../../src/__tests__/helpers/factory-records-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryRecordsConformance(setupFactoryPostgres);
