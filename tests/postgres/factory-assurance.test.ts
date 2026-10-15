import { factoryAssuranceConformance } from "../../src/__tests__/helpers/factory-assurance-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryAssuranceConformance(setupFactoryPostgres);
