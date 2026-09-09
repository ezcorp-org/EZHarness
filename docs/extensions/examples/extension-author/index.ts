import { createToolDispatcher, getChannel, toolResult } from "@ezcorp/sdk/runtime";

export function migrationStatus() {
  return toolResult(JSON.stringify({
    code: "EXTENSION_AUTHOR_MOVED_TO_HOST",
    message: "Use the host extension tools to create, build, review, and activate extensions.",
    tools: ["extensions_describe", "extensions_workspace", "extensions_build", "extensions_inspect", "extensions_release"],
    approval: "A user must approve the exact release in the host review page.",
  }));
}

export function start(): void {
  getChannel();
  createToolDispatcher({ migration_status: migrationStatus });
}
