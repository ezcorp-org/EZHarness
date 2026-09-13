import { factoryInboxConformance } from "../../src/__tests__/helpers/factory-inbox-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryInboxConformance(setupFactoryPostgres);
