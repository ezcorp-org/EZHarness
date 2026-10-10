import { factoryBudgetsConformance } from "../../src/__tests__/helpers/factory-budgets-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryBudgetsConformance(setupFactoryPostgres);
