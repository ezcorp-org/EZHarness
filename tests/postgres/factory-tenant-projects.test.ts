import { factoryTenantProjectsConformance } from "../../src/__tests__/helpers/factory-tenant-projects-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryTenantProjectsConformance(setupFactoryPostgres);
