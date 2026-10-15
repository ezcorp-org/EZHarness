import { factoryExecutionGatewayConformance } from "../../src/__tests__/helpers/factory-execution-gateway-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryExecutionGatewayConformance(setupFactoryPostgres);
