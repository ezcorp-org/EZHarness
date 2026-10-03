import { factoryRunLifecycleConformance } from "../../src/__tests__/helpers/factory-run-lifecycle-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryRunLifecycleConformance(setupFactoryPostgres);
