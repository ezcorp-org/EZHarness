// Host-only re-export shim.
//
// The implementation MOVED into the task-tracking extension's own dir
// (docs/extensions/examples/task-tracking/task-dependencies.ts) so the jailed
// subprocess can read it under the landlock sandbox (issue #60 — a runtime
// VALUE import from `src/**` died at module-load with EACCES). This shim keeps
// `$server/runtime/task-dependencies` resolving for the host's web `/start`
// pre-start gate: the host runs UNJAILED, so importing the ext-dir module is
// fine. No logic lives here — see the ext-dir file for the pure helpers +
// their tests.
export {
  unsatisfiedDeps,
  isBlocked,
  detectCycle,
} from "../../docs/extensions/examples/task-tracking/task-dependencies";
export type {
  TaskStatus,
  ReadonlyTask,
  ReadonlySnapshot,
} from "../../docs/extensions/examples/task-tracking/task-dependencies";
