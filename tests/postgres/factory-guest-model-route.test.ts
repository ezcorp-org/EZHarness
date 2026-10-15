import { factoryGuestModelRouteConformance } from "../../src/__tests__/helpers/factory-guest-model-route-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryGuestModelRouteConformance(setupFactoryPostgres);
