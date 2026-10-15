import { factoryPackageFenceConformance } from "../../src/__tests__/helpers/factory-package-fence-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryPackageFenceConformance(setupFactoryPostgres);
