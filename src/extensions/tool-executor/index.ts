/**
 * Barrel for the split tool-executor. Re-exports the exact public surface the
 * former single `tool-executor.ts` module exposed, so every importer and test
 * that does `from ".../tool-executor"` keeps resolving unchanged. Internal
 * helpers (the extracted reverse-RPC handler bodies, provenance resolvers, the
 * dispatch table, the per-turn/depth state) stay module-private to their files.
 */
export { ToolExecutor } from "./executor";

export {
  parseMaxToolCallsPerTurn,
  MAX_TOOL_CALLS_PER_TURN,
  MaxToolCallsExceededError,
  _resetToolCallsCounterForTests,
  _getToolCallsThisTurnForTests,
  _resetConversationCallDepthForTests,
  _peekConversationCallDepthMapSizeForTests,
} from "./limits";

export {
  parseHostReverseRpcTimeoutMs,
  HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
} from "./reverse-rpc-timeout";

export { PermissionDeniedError } from "./errors";
export type { PermissionChecker, ArgsResolver, ToolExecutorOptions } from "./errors";

export { extensionToAgentTool } from "./agent-tool";

export {
  clearFsDeprecationForExtension,
  _resetFsDeprecationWarningsForTests,
} from "./fs-rpc";
