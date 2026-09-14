import { factoryTaskStopsConformance } from "../../src/__tests__/helpers/factory-task-stops-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryTaskStopsConformance(setupFactoryPostgres);
