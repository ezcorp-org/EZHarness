/** The task stop's error codes and error, with no database behind them (a host process uses them too). */
/** Widened from `string`. W14 maps each member to an HTTP status. */
export type FactoryTaskStopCode =
  | "factory_task_stop_scope"
  | "factory_task_stop_key_invalid"
  | "factory_task_stop_invalid"
  | "factory_task_stop_corrupt"
  | "factory_task_stop_not_found"
  | "factory_task_stop_conflict"
  | "factory_task_stop_stale"
  | "factory_task_stop_pool_mismatch"
  | "factory_task_stop_proof_invalid"
  | "factory_task_stop_clock_invalid"
  | "factory_task_stop_timeout";

/** Every member of `FactoryTaskStopCode`, so W14 can prove its mapping is total. */
export const FACTORY_TASK_STOP_CODES: readonly FactoryTaskStopCode[] = Object.freeze([
  "factory_task_stop_scope",
  "factory_task_stop_key_invalid",
  "factory_task_stop_invalid",
  "factory_task_stop_corrupt",
  "factory_task_stop_not_found",
  "factory_task_stop_conflict",
  "factory_task_stop_stale",
  "factory_task_stop_pool_mismatch",
  "factory_task_stop_proof_invalid",
  "factory_task_stop_clock_invalid",
  "factory_task_stop_timeout",
]);

export class FactoryTaskStopError extends Error {
  constructor(readonly code: FactoryTaskStopCode) { super(code); this.name = "FactoryTaskStopError"; }
}
