export type * from "./types";
export type * from "./kernel-types";
export { FACTORY_IR_SCHEMA_VERSION, FACTORY_LIMITS, FACTORY_SCHEMA_VERSION } from "./types";
export { factoryDefinitionJsonSchema, isFactoryDefinition } from "./schema";
export { evaluateExpression } from "./expressions";
export { firstValidationIssue, isSchemaContained, validatePortSchema, validateValue } from "./validation";
export { FactoryKernelError, advanceKernel, createKernelState } from "./kernel";
export { simulateFactory } from "./simulator";
export type { FactorySimulatorOptions, SimulationResult, SimulatedOutcome } from "./simulator";
