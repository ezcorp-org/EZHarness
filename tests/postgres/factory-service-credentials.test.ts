import { factoryServiceCredentialsConformance } from "../../src/__tests__/helpers/factory-service-credentials-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryServiceCredentialsConformance(setupFactoryPostgres);
