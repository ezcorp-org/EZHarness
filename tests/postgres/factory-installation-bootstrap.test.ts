import { factoryInstallationBootstrapConformance } from "../../src/__tests__/helpers/factory-installation-bootstrap-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryInstallationBootstrapConformance(setupFactoryPostgres);
