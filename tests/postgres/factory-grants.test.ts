import { factoryGrantsConformance } from "../../src/__tests__/helpers/factory-grants-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryGrantsConformance(setupFactoryPostgres);
