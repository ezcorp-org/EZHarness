import { factoryReleaseAuthorityConformance } from "../../src/__tests__/helpers/factory-release-authority-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryReleaseAuthorityConformance(setupFactoryPostgres);
