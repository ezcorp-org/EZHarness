/**
 * The server graph that `$lib/server/context` builds from on its first initialization. It is a separate module so
 * that `context.ts` can load it lazily, after the database opens, instead of at import time. See `loadServerGraph`
 * in `context.ts`.
 */
import { loadAgents } from "$server/runtime/loader";
import { EventBus } from "$server/runtime/events";
import { registerPreviewBus } from "$server/runtime/preview/preview-bus-registry";
import { registerBriefingRuntime } from "$server/runtime/briefing/runtime-registry";
import { registerGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import { registerWorkflowRuntime } from "$server/runtime/workflow/runtime-registry";
import { ensureBriefingAgentConfig } from "$server/runtime/briefing/agent-config";
import { registerBriefingHubPage } from "$server/runtime/briefing/hub-page";
import { registerWorkflowApprovalsHubPage } from "$server/runtime/workflow-approvals-hub-page";
import { triggerBriefingRunNow } from "$lib/server/briefing-run-now";
import { AgentExecutor } from "$server/runtime/executor";
import { WorkflowExecutor } from "$server/runtime/workflow-executor";
import { loadYamlWorkflows } from "$server/runtime/workflow-loader";
import { loadReleaseWorkflowEntries } from "$server/runtime/workflow-release-assets";
import { warmKiloCatalog } from "$server/providers/kilo";
import { loadDbCachedWorkflows } from "$server/db/queries/workflows";
import { systemCachedWorkflow } from "$server/runtime/workflow-scope";
import { makeNestedWorkflowResolver } from "$server/runtime/nested-workflow-resolver";
import { terminalizeOrphanedWorkflowRuns } from "$server/db/queries/workflow-runs";
import { startBackups, stopBackups } from "$server/db/backup";
import { ensureBundledExtensions } from "$server/extensions/bundled";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { flushPermissionAuditForShutdown, getPermissionEngine } from "$server/extensions/permission-engine";
import { reconcileExtensionLifecycle, recoverExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { startExtensionDeliveryRuntime, stopExtensionDeliveryRuntime } from "$server/extensions/delivery-runtime";
import { ExtensionStateMediator, setStateMediator as setStateMediatorSingleton } from "$server/extensions/state-mediator";
import { LifecycleHookDispatcher } from "$server/extensions/lifecycle-dispatcher";
import { EventSubscriptionDispatcher } from "$server/extensions/event-subscription-dispatcher";
import { getConversationExtensionIds } from "$server/db/queries/conversation-extensions";
import { createCommandRegistry } from "$server/runtime/commands/registry";
import { listUserCommands } from "$server/db/queries/user-commands";
import { initGoalHost, parseGoalEnabled } from "$server/runtime/goal-host";

/** One object, so that `context.ts` takes the whole graph from a single lazy import. */
export const serverGraph = {
  loadAgents,
  EventBus,
  registerPreviewBus,
  registerBriefingRuntime,
  registerGithubProjectsEmit,
  registerWorkflowRuntime,
  ensureBriefingAgentConfig,
  registerBriefingHubPage,
  registerWorkflowApprovalsHubPage,
  triggerBriefingRunNow,
  AgentExecutor,
  WorkflowExecutor,
  loadYamlWorkflows,
  loadReleaseWorkflowEntries,
  warmKiloCatalog,
  loadDbCachedWorkflows,
  systemCachedWorkflow,
  makeNestedWorkflowResolver,
  terminalizeOrphanedWorkflowRuns,
  startBackups,
  stopBackups,
  ensureBundledExtensions,
  ExtensionRegistry,
  ToolExecutor,
  flushPermissionAuditForShutdown,
  getPermissionEngine,
  reconcileExtensionLifecycle,
  recoverExtensionLifecycle,
  startExtensionDeliveryRuntime,
  stopExtensionDeliveryRuntime,
  ExtensionStateMediator,
  setStateMediatorSingleton,
  LifecycleHookDispatcher,
  EventSubscriptionDispatcher,
  getConversationExtensionIds,
  createCommandRegistry,
  listUserCommands,
  initGoalHost,
  parseGoalEnabled,
};
