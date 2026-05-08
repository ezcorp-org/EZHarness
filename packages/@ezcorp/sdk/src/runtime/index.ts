// @ezcorp/sdk/runtime — runtime helpers barrel.
//
// Populated by tasks #1 (channel) and #2 (fs/lock/rpc).

export {
  findProjectRoot,
  getExtensionDataDir,
  atomicWrite,
  atomicRead,
  loadJSON,
  saveJSON,
  // ── Phase 3 host-mediated fs helpers ──
  fsRead,
  fsWrite,
  fsList,
  fsStat,
  fsExists,
  fsMkdir,
  fsUnlink,
} from "./fs";
export type { FsListEntry, FsStatResult } from "./fs";

export { withLock, createMutex } from "./lock";

export {
  toolResult,
  toolError,
  createToolDispatcher,
  // Internal (underscore prefix): exposed for extension test files that
  // need to redirect dispatcher registration into an isolated test
  // channel. Phase 3 will partition this into a non-public entry before
  // the SDK is published.
  _setDispatcherRegister,
} from "./rpc";

export type { ToolHandler, ToolHandlerContext, ToolDispatcherOptions } from "./rpc";

export {
  getChannel,
  __resetChannelForTests,
  JsonRpcError,
  // Internal (`ForTests` suffix): exposed for extension test files that
  // build an isolated channel pipe without touching process.stdin /
  // process.stdout. Phase 3 will partition this into a non-public entry
  // before the SDK is published.
  createHostChannelForTests,
} from "./channel";
export type { HostChannel } from "./channel";

// ── Phase 2 runtime wrappers ────────────────────────────────────

export { fetchPermitted } from "./http";

export { invoke } from "./invoke";
export type { InvokeOptions } from "./invoke";

export { withToolContext, getToolContext } from "./tool-context";
export type { ToolContext } from "./tool-context";

export { PanelBuilder } from "./panel";
export type {
  PanelColor,
  PanelTextVariant,
  PanelStatusState,
  PanelListItemStatus,
  PanelBuilderListItem,
  PanelBuilderAction,
} from "./panel";

export { registerLifecycleHook } from "./lifecycle";
export type { LifecycleEvent } from "./lifecycle";

export { Storage } from "./storage";
export type {
  StorageScope,
  StorageGetResult,
  StorageSetResult,
  StorageSetOptions,
  StorageListOptions,
  StorageListResult,
  StorageDeleteResult,
  StorageBatchOp,
} from "./storage";

// ── Phase 2b capability wrappers ────────────────────────────────

export { AgentConfigs } from "./agent-configs";
export type { AgentConfigSummary } from "./agent-configs";

export { TaskEvents } from "./task-events";
export type {
  TaskStatus,
  AssignmentStatus,
  TaskAssignment,
  TrackedSubtask,
  TrackedTask,
} from "./task-events";

export { registerEventHandler, Events } from "./events";
export type { SubscribableEvent, SubscribableEventMap } from "./events";

// ── Phase A1 canvas wrapper ─────────────────────────────────────

export { createCanvas } from "./canvas";
export type {
  Canvas,
  CanvasContext,
  CanvasEventHandler,
  CanvasOptions,
  DefaultCanvasEvents,
} from "./canvas";

// ── Phase A1 preview helpers ────────────────────────────────────

export {
  SANDBOX_FLAGS_STRICT,
  assertContentType,
  contentTypeForPath,
  extensionDataUrl,
} from "./preview";

// ── Phase 2d spawn wrapper ──────────────────────────────────────

export { spawnAssignment } from "./spawn";
export type { SpawnAssignmentInput, SpawnAssignmentHandle } from "./spawn";

// ── Phase 4 cancel-run wrapper (§5.3) ───────────────────────────

export { cancelRun } from "./cancel-run";
export type { CancelRunResult } from "./cancel-run";

// ── Phase B per-extension settings ──────────────────────────────

export { getSetting, getAllSettings } from "./settings";

// ── Phase 51 capability surfaces ────────────────────────────────

export {
  Llm,
  LlmQuotaError,
  LlmProviderError,
  LlmCredentialError,
  NotImplementedError,
} from "./llm";
export type {
  LlmMessage,
  LlmCompleteOpts,
  LlmCompleteResult,
  LlmUsage,
  LlmBudgetSnapshot,
} from "./llm";

export { Memory } from "./memory";
export type {
  MemoryRecord,
  MemoryWriteInput,
  MemoryListOpts,
  MemoryCategory,
  MemoryConfidence,
  MemoryStatus,
} from "./memory";

export { Lessons } from "./lessons";
export type {
  LessonRecord,
  LessonInput,
  LessonsListOpts,
  LessonVisibility,
} from "./lessons";

export { Schedule } from "./schedule";
export type { ScheduleHandler, ScheduleHandlerContext } from "./schedule";
