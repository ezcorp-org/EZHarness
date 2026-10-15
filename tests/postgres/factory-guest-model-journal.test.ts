import { factoryGuestModelJournalConformance } from "../../src/__tests__/helpers/factory-guest-model-journal-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryGuestModelJournalConformance(setupFactoryPostgres);
