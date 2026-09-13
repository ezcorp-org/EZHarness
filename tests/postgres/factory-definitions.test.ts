import { factoryDefinitionsConformance } from "../../src/__tests__/helpers/factory-definitions-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryDefinitionsConformance(setupFactoryPostgres);
