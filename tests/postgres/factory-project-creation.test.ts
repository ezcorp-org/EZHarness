import { factoryProjectCreationConformance } from "../../src/__tests__/helpers/factory-project-creation-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryProjectCreationConformance(setupFactoryPostgres);
