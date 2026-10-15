import { factoryReleaseConformance } from "../../src/__tests__/helpers/factory-release-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryReleaseConformance(setupFactoryPostgres);
